import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { findBrowserPid, sweepAbandonedScratch, waitForExit } from "./browser-process.ts";

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
    ["-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`],
    { stdio: "ignore" },
  );

  await once(child, "spawn");

  return child;
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
  it("kills a hung ps child and returns no PID when its own budget expires", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "xrio-hung-ps-"));
    const pidFile = await createHungPs(directory);
    let pid: number | undefined;

    try {
      vi.stubEnv("PATH", directory);
      const scanning = findBrowserPid("xrio-hung-ps", SCAN_BUDGET_MS);
      await vi.waitFor(async () => {
        pid = Number(await readFile(pidFile, "utf-8"));
        expect(pid).toBeGreaterThan(0);
      });
      await expect(scanning).resolves.toBeUndefined();

      if (pid === undefined) {
        throw new Error("The ps child did not record its process ID.");
      }

      expect({ exited: await waitForExit(pid) }).toStrictEqual({ exited: true });
    } finally {
      vi.unstubAllEnvs();

      if (pid !== undefined) {
        killPid(pid);
      }

      await rm(directory, { force: true, recursive: true });
    }
  });

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
    const directory = await mkdtemp(path.join(tmpdir(), "xrio-no-ps-"));

    try {
      vi.stubEnv("PATH", directory);
      const startedAt = performance.now();
      await expect(findBrowserPid("xrio-no-ps", 10_000)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(performance.now() - startedAt).toBeLessThan(SCAN_BUDGET_MS);
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe.runIf(process.platform === "linux")("Linux process scanning", () => {
  it("finds a real child with the matching profile marker", async () => {
    const profile = path.join(tmpdir(), `xrio-scan-${crypto.randomUUID()}`);
    const child = await startChild(profile);

    try {
      if (child.pid === undefined) {
        throw new Error("The child did not receive a process ID.");
      }

      await expect(findBrowserPid(profile, SCAN_BUDGET_MS)).resolves.toBe(child.pid);
    } finally {
      await stopChild(child);
    }
  });

  it("returns no PID for a profile with no matching process", async () => {
    const profile = path.join(tmpdir(), `xrio-absent-${crypto.randomUUID()}`);
    await expect(findBrowserPid(profile, 50)).resolves.toBeUndefined();
  });
});
