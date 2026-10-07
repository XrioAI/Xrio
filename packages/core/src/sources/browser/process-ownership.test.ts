import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";

import { describe, expect, it, vi } from "vite-plus/test";

import { holdUnreapedGroup, processStateOf } from "../../testing/unreaped-group.ts";
import { spawnChrome } from "./browser-process.ts";
import { killProcessGroup, retireProcessGroup, waitForGroupExit } from "./group-lifetime.ts";

const MAIN_THREAD_EXITS = `
import ctypes, threading, time
threading.Thread(target=lambda: time.sleep(3600)).start()
print('ready', flush=True)
ctypes.CDLL(None).pthread_exit(None)
`;

const LIVE_WINDOW_MS = 400;

const deadline = () => AbortSignal.timeout(2000);

const environment = { PATH: process.env.PATH ?? "" };

describe("owned process groups", () => {
  it("owns an immediately exiting child before awaiting it", async () => {
    const chrome = spawnChrome(process.execPath, ["-e", ""], environment);

    expect(chrome.pid).toBeGreaterThan(0);
    await chrome.leaderExited;
    await expect(waitForGroupExit(chrome.pid, deadline())).resolves.toBeTruthy();
  });

  it("waits for the complete owned group after killing it", async () => {
    const chrome = spawnChrome(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      environment,
    );

    try {
      await expect(
        waitForGroupExit(chrome.pid, AbortSignal.timeout(LIVE_WINDOW_MS)),
      ).resolves.toBeFalsy();
      await expect(waitForGroupExit(chrome.pid, AbortSignal.abort())).resolves.toBeFalsy();
      killProcessGroup(chrome.pid);
      await chrome.leaderExited;
      await expect(waitForGroupExit(chrome.pid, deadline())).resolves.toBeTruthy();
    } finally {
      killProcessGroup(chrome.pid);
      await chrome.leaderExited;
    }
  });

  it("never signals a group that has no members left", async () => {
    const chrome = spawnChrome(process.execPath, ["-e", ""], environment);

    await chrome.leaderExited;
    await waitForGroupExit(chrome.pid, deadline());
    const signal = vi.spyOn(process, "kill");

    try {
      killProcessGroup(chrome.pid);
      expect(signal.mock.calls.every(([, kind]) => kind === 0)).toBeTruthy();
    } finally {
      signal.mockRestore();
    }
  });

  it("reports an absent executable without an unhandled child error", async () => {
    expect(() => spawnChrome("/does-not-exist/xrio-chrome", [], {})).toThrow(
      "Chrome could not start",
    );
    await nextTurn();
  });
});

describe.runIf(process.platform === "linux")("process groups left to a non-reaping parent", () => {
  it.each([
    { fate: "reaped", leaderState: undefined },
    { fate: "zombie", leaderState: "Z" },
  ] as const)(
    "counts a group as gone once only zombies hold it (leader $fate)",
    async ({ fate, leaderState }) => {
      await using group = await holdUnreapedGroup({ leader: fate });
      const zombieMember = { group: group.leader, state: "Z" };
      const leader = await processStateOf(group.leader);

      expect({
        groupIdHeld: process.kill(-group.leader, 0),
        leaderState: leader?.state,
        member: await processStateOf(group.member),
      }).toStrictEqual({ groupIdHeld: true, leaderState, member: zombieMember });

      const waited = await waitForGroupExit(group.leader, deadline());
      const retired = await retireProcessGroup(group.leader, deadline());

      expect({ member: await processStateOf(group.member), retired, waited }).toStrictEqual({
        member: zombieMember,
        retired: true,
        waited: true,
      });
    },
  );

  it("keeps waiting for a process whose main thread exited while a worker thread runs", async () => {
    const child = spawn("python3", ["-c", MAIN_THREAD_EXITS], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });

    const closed = once(child, "close");
    await once(child.stdout, "data");
    const pid = child.pid ?? Number.NaN;

    try {
      await vi.waitFor(async () => {
        await expect(processStateOf(pid)).resolves.toStrictEqual({ group: pid, state: "Z" });
      });
      await expect(waitForGroupExit(pid, AbortSignal.timeout(LIVE_WINDOW_MS))).resolves.toBeFalsy();
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
  });
});
