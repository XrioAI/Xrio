import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { fakeChromePath } from "../../testing/fake-chrome-path.ts";
import { leftovers, nothingLeft } from "../../testing/leftovers.ts";
import { noPins } from "../../testing/no-pins.ts";
import { plannedScrapes } from "../../testing/planned-scrapes.ts";
import { holdUnreapedGroup, processStateOf } from "../../testing/unreaped-group.ts";
import { spawnChrome, sweepAbandonedScratch } from "./browser-process.ts";
import { cdpDriver } from "./cdp/driver.ts";
import { waitForGroupExit } from "./group-lifetime.ts";

const EXIT_WAIT_MS = 5000;

const SWEEP_TIMEOUT_MS = 8000;

const waitForExit = async (pid: number, parent?: AbortSignal): Promise<boolean> =>
  await waitForGroupExit(
    pid,
    AbortSignal.any([AbortSignal.timeout(EXIT_WAIT_MS), ...(parent === undefined ? [] : [parent])]),
  );

const SCAN_BUDGET_MS = 1000;

const createHungPs = async (directory: string): Promise<string> => {
  const pidFile = path.join(directory, "pid");

  await writeFile(
    path.join(directory, "ps"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );

  return pidFile;
};

const killPid = (pid: number): void => {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
};

const startChild = async (profile: string): Promise<ChildProcess> => {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`, "about:blank"],
    { detached: true, stdio: "ignore" },
  );

  await once(child, "spawn");

  return child;
};

const abandonDirectory = async (root: string): Promise<string> => {
  const formerOwner = await startChild("xrio-former-owner");
  const abandoned = path.join(root, "abandoned");

  await stopChild(formerOwner);
  await mkdir(abandoned, { mode: 0o700 });
  await writeFile(
    path.join(abandoned, "xrio-owner.json"),
    JSON.stringify({ createdAt: 0, pid: formerOwner.pid }),
  );

  return abandoned;
};

describe("process exit waiting", () => {
  it("stops waiting for a live process when its caller aborts", async () => {
    const child = await startChild("xrio-exit-abort");

    try {
      if (child.pid === undefined) {
        throw new Error("The child did not receive a process ID.");
      }

      expect({ exited: await waitForExit(child.pid, AbortSignal.abort()) }).toStrictEqual({
        exited: false,
      });
    } finally {
      await stopChild(child);
    }
  });

  it("bounds the wait for a process that stays alive", async () => {
    const child = await startChild("xrio-exit-timeout");

    try {
      if (child.pid === undefined) {
        throw new Error("The child did not receive a process ID.");
      }

      expect({ exited: await waitForExit(child.pid) }).toStrictEqual({ exited: false });
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      await stopChild(child);
    }
  }, 8000);

  it("confirms that a child has exited", async () => {
    const child = await startChild("xrio-exit-success");

    try {
      if (child.pid === undefined) {
        throw new Error("The child did not receive a process ID.");
      }

      await stopChild(child);
      expect({ exited: await waitForExit(child.pid) }).toStrictEqual({ exited: true });
    } finally {
      await stopChild(child);
    }
  });
});

describe.runIf(process.platform === "darwin")("macOS process scanning", () => {
  it("keeps an abandoned directory when checking for its browser times out", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-sweep-hung-ps-"));
    const abandoned = path.join(root, "abandoned");
    const pidFile = await createHungPs(root);
    const formerOwner = await startChild("xrio-former-owner");
    let scanPid: number | undefined;

    try {
      if (formerOwner.pid === undefined) {
        throw new Error("The child did not receive a process ID.");
      }

      await stopChild(formerOwner);
      await mkdir(abandoned, { mode: 0o700 });
      const owner = JSON.stringify({ createdAt: 0, pid: formerOwner.pid });
      const ownerFile = path.join(abandoned, "xrio-owner.json");

      await writeFile(ownerFile, owner);
      vi.stubEnv("PATH", root);
      const sweeping = sweepAbandonedScratch(root, Date.now());

      await vi.waitFor(async () => {
        scanPid = Number(await readFile(pidFile, "utf-8"));
        expect(scanPid).toBeGreaterThan(0);
      });
      await expect(sweeping).resolves.toStrictEqual([]);
      await expect(readFile(ownerFile, "utf-8")).resolves.toBe(owner);

      if (scanPid === undefined) {
        throw new Error("The ps child did not record its process ID.");
      }

      expect({ exited: await waitForExit(scanPid) }).toStrictEqual({ exited: true });
    } finally {
      vi.unstubAllEnvs();
      await stopChild(formerOwner);

      if (scanPid !== undefined) {
        killPid(scanPid);
      }

      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects promptly when ps cannot be spawned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-no-ps-"));

    try {
      await abandonDirectory(root);
      vi.stubEnv("PATH", root);
      const startedAt = performance.now();
      await expect(sweepAbandonedScratch(root, Date.now())).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(performance.now() - startedAt).toBeLessThan(SCAN_BUDGET_MS);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("process scanning in the sweep", () => {
  it("kills the browser of an abandoned directory, then removes it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-sweep-browser-"));
    const abandoned = await abandonDirectory(root);
    const browser = await startChild(path.join(abandoned, "profile"));

    try {
      await expect(sweepAbandonedScratch(root, Date.now())).resolves.toStrictEqual([abandoned]);
      expect(browser.signalCode).toBe("SIGKILL");
    } finally {
      await stopChild(browser);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("removes an abandoned directory that no browser uses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-sweep-idle-"));
    const abandoned = await abandonDirectory(root);

    try {
      await expect(sweepAbandonedScratch(root, Date.now())).resolves.toStrictEqual([abandoned]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe.runIf(process.platform === "linux")("sweeping after a non-reaping parent", () => {
  it(
    "removes an abandoned directory whose killed browser leaves only unreaped zombies",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "xrio-sweep-zombie-"));

      try {
        const abandoned = await abandonDirectory(root);

        await using group = await holdUnreapedGroup({
          argument: `--user-data-dir=${path.join(abandoned, "profile")}`,
          leader: "running",
        });

        const zombie = { group: group.leader, state: "Z" };

        await expect(sweepAbandonedScratch(root, Date.now())).resolves.toStrictEqual([abandoned]);
        await expect(processStateOf(group.leader)).resolves.toStrictEqual(zombie);
        await expect(processStateOf(group.member)).resolves.toStrictEqual(zombie);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
    SWEEP_TIMEOUT_MS,
  );
});

interface BrowserEvent {
  readonly event: string;
  readonly detail: string;
}

const isBrowserEvent = (message: unknown): message is BrowserEvent =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  typeof message.event === "string" &&
  "detail" in message &&
  typeof message.detail === "string";

const recordLaunchEvents = (): {
  readonly seen: string[];
  readonly details: string[];
} & Disposable => {
  const seen: string[] = [];
  const details: string[] = [];

  const record: ChannelListener = (message) => {
    if (isBrowserEvent(message) && message.event.startsWith("browser-")) {
      seen.push(message.event);
      details.push(message.detail);
    }
  };

  subscribe("xrio:event", record);

  return {
    [Symbol.dispose]: () => {
      unsubscribe("xrio:event", record);
    },
    details,
    seen,
  };
};

const scrapeWith = async (browserPath: string) => {
  const browsers = plannedScrapes(cdpDriver, 1);
  using deadline = startDeadline(10_000);

  try {
    return await browsers.capture({
      browserArgs: [],
      browserPath,
      deadline,
      mode: "headless",
      pins: noPins,
      proxy: undefined,
      url: new URL("https://fake.test/page"),
    });
  } finally {
    await browsers.close();
  }
};

describe("the browser-argv event", () => {
  it("publishes exactly the argv the browser process received", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-argv-"));
    const received = path.join(root, "received");
    const executable = path.join(root, "chrome");

    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(received)}\n`);
    await chmod(executable, 0o755);

    try {
      using events = recordLaunchEvents();

      const chrome = spawnChrome(
        executable,
        ["--user-data-dir=/tmp/xrio-1/b1/profile", "--window-size=1280,800", "about:blank"],
        { PATH: process.env.PATH ?? "" },
      );

      await chrome.leaderExited;

      expect(events.seen).toStrictEqual(["browser-argv"]);
      await expect(readFile(received, "utf-8")).resolves.toBe(
        "--user-data-dir=/tmp/xrio-1/b1/profile\n--window-size=1280,800\nabout:blank\n",
      );
      expect(events.details).toStrictEqual([
        '["--user-data-dir=/tmp/xrio-1/b1/profile","--window-size=1280,800","about:blank"]',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("publishes one event per launch, before browser-launched", async () => {
    using events = recordLaunchEvents();

    await scrapeWith(await fakeChromePath("normal"));

    expect(events.seen).toStrictEqual(["browser-argv", "browser-launched"]);

    const argv: unknown = JSON.parse(events.details[0] ?? "null");

    expect(argv).toContain("--remote-debugging-pipe");
    expect(argv).toContain("--headless");
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("publishes the argv of a launch that fails after the process starts", async () => {
    using events = recordLaunchEvents();

    await expect(scrapeWith(await fakeChromePath("no-start"))).rejects.toMatchObject({
      code: "BROWSER_LAUNCH_FAILED",
    });

    expect(events.seen).toStrictEqual(["browser-argv", "browser-launched"]);
    expect(JSON.parse(events.details[0] ?? "null")).toContain("--remote-debugging-pipe");
  });

  it("publishes the argv of a launch whose binary cannot be executed", () => {
    using events = recordLaunchEvents();

    expect(() => spawnChrome("/does-not-exist/xrio-chrome", ["--headless"], {})).toThrow(
      "Chrome could not start at /does-not-exist/xrio-chrome.",
    );
    expect(events.seen).toStrictEqual(["browser-argv"]);
    expect(events.details).toStrictEqual(['["--headless"]']);
  });
});
