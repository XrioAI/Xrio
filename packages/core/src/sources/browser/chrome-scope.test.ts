import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { planIdentity } from "../../humanizer/humanizer.ts";
import { fixedDevice } from "../../testing/fixed-seed.ts";
import { noPins } from "../../testing/no-pins.ts";
import { holdUnreapedGroup, processStateOf } from "../../testing/unreaped-group.ts";
import { createScratchDir, spawnChrome } from "./browser-process.ts";
import { ChromeScope } from "./chrome-scope.ts";
import { killProcessGroup, waitForGroupExit } from "./group-lifetime.ts";
import { planLaunch } from "./launch-plan.ts";
import { parseChromeProduct, TEARDOWN_BUDGET_MS } from "./port.ts";
import type { BrowserDriver, DriverBrowser } from "./port.ts";

const SURVIVING_DESCENDANT = `
import os, sys, time
if sys.platform.startswith('linux'):
    import ctypes
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('cannot become child subreaper')
read, write = os.pipe()
leader = os.fork()
if leader == 0:
    os.close(read)
    os.setsid()
    descendant = os.fork()
    if descendant == 0:
        os.close(write)
        while True: time.sleep(1)
    os.write(write, b'ready')
    os._exit(0)
os.close(write)
os.read(read, 5)
os.close(read)
os.waitpid(leader, 0)
print(leader, flush=True)
if sys.platform.startswith('linux'):
    os.waitpid(-1, 0)
else:
    while True:
        try: os.kill(-leader, 0)
        except ProcessLookupError: break
        except PermissionError: pass
        time.sleep(0.01)
`;

const environment = { PATH: process.env.PATH ?? "" };

const PROBE_BUDGET_MS = 1000;

const TIMEOUT_MARGIN_MS = 2000;

const probeBudget = () => AbortSignal.timeout(PROBE_BUDGET_MS);

const roots: string[] = [];

const setup = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xrio-scope-"));

  roots.push(root);
  const scope = new ChromeScope(await createScratchDir(Date.now(), root));

  const plan = planLaunch({
    browserArgs: [],
    browserPath: process.execPath,
    display: undefined,
    headless: true,
    identity: planIdentity({
      capabilities: { permittedCpus: 32, platform: process.platform },
      device: fixedDevice,
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: "UTC",
      mode: "headless",
      pins: noPins,
    }).inputs,
    scratchDir: scope.scratch.path,
    xauthority: undefined,
  });

  return { plan, scope };
};

const fakeBrowser = (): DriverBrowser => ({
  close: async () => {
    await Promise.resolve();
  },
  evaluateIsolated: async () => {
    await Promise.resolve();
    throw new Error("unused");
  },
  navigate: async () => {
    await Promise.resolve();
  },
  onEvent: () => () => {},
  product: parseChromeProduct("Chrome/154.0.8037.57"),
});

describe("ChromeScope retirement", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map(async (root) => {
        await rm(root, { force: true, recursive: true });
      }),
    );
  });

  it("shares the same retirement promise and removes scratch before any launch", async () => {
    const { scope } = await setup();
    const closing = scope.retire();

    expect(scope.retire()).toBe(closing);
    await expect(closing).resolves.toStrictEqual({ exited: true });
    await expect(access(scope.scratch.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires a surviving descendant after its leader has exited", async () => {
    const { plan, scope } = await setup();

    const reaper = spawn("python3", ["-c", SURVIVING_DESCENDANT], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const closed = once(reaper, "close");
    const pieces: readonly unknown[] = await once(reaper.stdout, "data");
    const [output] = pieces;
    const pid = Number(String(output).trim());

    expect(pid).toBeGreaterThan(0);
    await expect(waitForGroupExit(pid, probeBudget())).resolves.toBeFalsy();

    const driver: BrowserDriver = {
      launch: async (_plan, _deadline, owned) => {
        owned(pid);
        await Promise.resolve();
        throw new Error("leader already exited");
      },
    };

    using deadline = startDeadline(2000);

    try {
      await expect(scope.launch(driver, plan, deadline)).rejects.toThrow("leader already exited");
      await expect(scope.retire()).resolves.toStrictEqual({ exited: true });
      await expect(waitForGroupExit(pid, probeBudget())).resolves.toBeTruthy();
      await closed;
      expect(reaper.exitCode).toBe(0);
    } finally {
      killProcessGroup(pid);
      await closed;
    }
  });

  it.runIf(process.platform === "linux")(
    "retires a group whose only members are unreaped zombies and removes scratch",
    async () => {
      const { plan, scope } = await setup();
      await using group = await holdUnreapedGroup({ leader: "reaped" });

      const driver: BrowserDriver = {
        launch: async (_plan, _deadline, owned) => {
          owned(group.leader);
          await Promise.resolve();

          return fakeBrowser();
        },
      };

      using deadline = startDeadline(2000);

      await scope.launch(driver, plan, deadline);
      await expect(scope.retire()).resolves.toStrictEqual({ exited: true });
      await expect(access(scope.scratch.path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(processStateOf(group.member)).resolves.toStrictEqual({
        group: group.leader,
        state: "Z",
      });
    },
    TEARDOWN_BUDGET_MS + TIMEOUT_MARGIN_MS,
  );

  it("kills the owned group when launch fails after spawning", async () => {
    const { plan, scope } = await setup();
    const child = spawnChrome(process.execPath, ["-e", "setInterval(() => {}, 1000)"], environment);

    const driver: BrowserDriver = {
      launch: async (_plan, _deadline, owned) => {
        owned(child.pid);
        await Promise.resolve();
        throw new Error("failed setup");
      },
    };

    using deadline = startDeadline(2000);

    await expect(scope.launch(driver, plan, deadline)).rejects.toThrow("failed setup");
    await expect(scope.retire()).resolves.toStrictEqual({ exited: true });
    await child.leaderExited;
    await expect(access(scope.scratch.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never signals a group after its child has already exited", async () => {
    const { plan, scope } = await setup();
    const child = spawnChrome(process.execPath, ["-e", ""], environment);

    await child.leaderExited;

    const driver: BrowserDriver = {
      launch: async (_plan, _deadline, owned) => {
        owned(child.pid);
        await Promise.resolve();

        return fakeBrowser();
      },
    };

    using deadline = startDeadline(2000);

    await scope.launch(driver, plan, deadline);
    const signal = vi.spyOn(process, "kill");

    await expect(scope.retire()).resolves.toStrictEqual({ exited: true });
    expect(signal.mock.calls.every(([, kind]) => kind === 0)).toBeTruthy();
  });

  it("rejects a driver that resolves without ownership and retains scratch", async () => {
    const { plan, scope } = await setup();

    const driver: BrowserDriver = {
      launch: async () => {
        await Promise.resolve();

        return fakeBrowser();
      },
    };

    using deadline = startDeadline(2000);

    await expect(scope.launch(driver, plan, deadline)).rejects.toThrow(
      "without reporting process ownership",
    );
    await expect(scope.retire()).resolves.toMatchObject({ exited: false });
    await expect(access(scope.scratch.path)).resolves.toBeUndefined();
  });
});
