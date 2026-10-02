import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";

import { directoriesIn } from "./launch-plan.ts";
import type { LaunchPlan } from "./launch-plan.ts";
import { settleWithin, withinSignal } from "./lifetime.ts";

const OWNER_FILE = "xrio-owner.json";

const ABANDONED_AFTER_MS = 60 * 60 * 1000;

const EXIT_WAIT_MS = 5000;

const EXIT_POLL_MS = 25;

export const PROCESS_SCAN_BUDGET_MS = 1000;

const STDERR_TAIL_BYTES = 8192;

const STDERR_DRAIN_MS = 500;

const OWNER_PERMISSION_UNIT = 0o100;

const PROCESS_ID = /^\d+$/u;

const EXITED_STATES = new Set(["Z", "X", "x"]);

interface Owner {
  pid: number;
  createdAt: number;
}

export interface ScratchDir {
  readonly path: string;
  readonly root: string;
}

const isOwner = (value: unknown): value is Owner =>
  typeof value === "object" &&
  value !== null &&
  "pid" in value &&
  typeof value.pid === "number" &&
  "createdAt" in value &&
  typeof value.createdAt === "number";

const currentUid = (): number => process.getuid?.() ?? 0;

export const scratchRoot = (): string => path.join("/tmp", `xrio-${currentUid()}`);

const groupAndOtherPermissions = (mode: number): number => mode % OWNER_PERMISSION_UNIT;

const ensureScratchRoot = async (root: string): Promise<void> => {
  await mkdir(root, { mode: 0o700, recursive: true });
  const stats = await lstat(root);

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${root} is not a directory Xrio can own.`);
  }

  if (stats.uid !== currentUid() || groupAndOtherPermissions(stats.mode) !== 0) {
    throw new Error(`${root} must belong to this user with mode 0700.`);
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const readOwner = async (directory: string): Promise<Owner | undefined> => {
  try {
    const owner: unknown = JSON.parse(await readFile(path.join(directory, OWNER_FILE), "utf-8"));

    return isOwner(owner) ? owner : undefined;
  } catch {
    return undefined;
  }
};

const listEntries = async (directory: string): Promise<Dirent[]> => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
};

export const createScratchDir = async (now: number, root = scratchRoot()): Promise<ScratchDir> => {
  await ensureScratchRoot(root);
  const directory = await mkdtemp(path.join(root, "b"));
  const owner: Owner = { createdAt: now, pid: process.pid };

  await writeFile(path.join(directory, OWNER_FILE), JSON.stringify(owner), { mode: 0o600 });

  return { path: directory, root };
};

export const removeScratchDir = async (
  { path: directory, root }: ScratchDir,
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted();
  const owner = await readOwner(directory);
  signal?.throwIfAborted();

  if (owner?.pid !== process.pid || path.dirname(directory) !== root) {
    throw new Error(`Refusing to delete ${directory}, which this process did not create.`);
  }

  await rm(directory, { force: true, recursive: true });
};

const writeAtomically = async (file: string, contents: string): Promise<void> => {
  const temporary = `${file}.${process.pid}.tmp`;

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, file);
};

export const prepareProfile = async (plan: LaunchPlan): Promise<void> => {
  await Promise.all(
    [
      plan.directories.profile,
      plan.directories.home,
      plan.directories.tmp,
      plan.directories.crashes,
      plan.directories.downloads,
    ].map(async (directory) => {
      await mkdir(directory, { mode: 0o700, recursive: true });
    }),
  );
  await Promise.all(
    plan.files.map(async (file) => {
      await writeAtomically(file.path, file.contents);
    }),
  );
};

const trySignal = (target: number): boolean => {
  try {
    return process.kill(target, "SIGKILL");
  } catch {
    return false;
  }
};

export const killProcessGroup = (pid: number): void => {
  trySignal(-pid);
  trySignal(pid);
};

export interface SpawnedBrowser {
  readonly pid: number;
  readonly pipe: { readonly toBrowser: Writable; readonly fromBrowser: Readable };
  readonly stop: (budgetMs: number) => Promise<void>;
  readonly stderrTail: () => Promise<string>;
}

const drainTail = (stderr: Readable): (() => Promise<string>) => {
  const closed = Promise.withResolvers<"closed">();
  let tail = Buffer.alloc(0);

  stderr.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-STDERR_TAIL_BYTES);
  });

  for (const ended of ["close", "error"]) {
    stderr.once(ended, () => {
      closed.resolve("closed");
    });
  }

  return async () => {
    await settleWithin(closed.promise, STDERR_DRAIN_MS);

    return tail.toString("utf-8");
  };
};

const pipesOf = (child: ChildProcess) => {
  const { 2: stderr, 3: toBrowser, 4: fromBrowser } = child.stdio;

  return stderr !== null && toBrowser instanceof Writable && fromBrowser instanceof Readable
    ? { fromBrowser, stderr, toBrowser }
    : undefined;
};

export const spawnBrowser = async (plan: LaunchPlan): Promise<SpawnedBrowser> => {
  const child = spawn(plan.executable, plan.args, {
    detached: true,
    env: plan.env,
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });

  await once(child, "spawn");
  const { pid } = child;
  const pipes = pipesOf(child);

  if (pid === undefined) {
    throw new Error("Chrome started without a process id.");
  }

  if (pipes === undefined) {
    killProcessGroup(pid);
    throw new Error("Chrome started without its DevTools pipe.");
  }

  const exited = Promise.withResolvers<"exited">();

  child.once("exit", () => {
    exited.resolve("exited");
  });

  const isRunning = () => child.exitCode === null && child.signalCode === null;

  const stop = async (budgetMs: number) => {
    await settleWithin(exited.promise, budgetMs);

    if (isRunning()) {
      killProcessGroup(pid);
      await settleWithin(exited.promise, budgetMs);
    }
  };

  return {
    pid,
    pipe: { fromBrowser: pipes.fromBrowser, toBrowser: pipes.toBrowser },
    stderrTail: drainTail(pipes.stderr),
    stop,
  };
};

const linuxProcessState = async (
  pid: string,
  signal: AbortSignal,
): Promise<{ state: string; group: number } | undefined> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, { encoding: "utf-8", signal });
    const [state = "", , group = ""] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");

    return { group: Number(group), state };
  } catch {
    return undefined;
  }
};

const isRunning = (entry: { state: string } | undefined): boolean =>
  entry !== undefined && !EXITED_STATES.has(entry.state);

const linuxStillRunning = async (pid: number, signal: AbortSignal): Promise<boolean> => {
  const entries = await withinSignal(async () => await readdir("/proc"), signal);
  signal.throwIfAborted();

  const members = await Promise.all(
    entries
      .filter((entry) => PROCESS_ID.test(entry))
      .map(async (entry) => await linuxProcessState(entry, signal)),
  );

  return (
    isRunning(await linuxProcessState(String(pid), signal)) ||
    members.some((member) => member?.group === pid && isRunning(member))
  );
};

const stillRunning = async (pid: number, signal: AbortSignal): Promise<boolean> =>
  process.platform === "linux"
    ? await linuxStillRunning(pid, signal)
    : isAlive(pid) || isAlive(-pid);

export const waitForExit = async (pid: number, parent?: AbortSignal): Promise<boolean> => {
  const timeout = AbortSignal.timeout(EXIT_WAIT_MS);
  const signal = parent === undefined ? timeout : AbortSignal.any([timeout, parent]);

  try {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a process known only by its pid has no exit event to await.
    while (await withinSignal(async () => await stillRunning(pid, signal), signal)) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a process known only by its pid has no exit event to await.
      await delay(EXIT_POLL_MS, undefined, { signal });
    }

    return true;
  } catch (error) {
    if (signal.aborted) {
      return false;
    }

    throw error;
  }
};

const readCommandLine = async (pid: string, signal: AbortSignal): Promise<string[]> => {
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, { encoding: "utf-8", signal });

    return commandLine.split("\0");
  } catch {
    return [];
  }
};

const linuxBrowserPid = async (
  marker: string,
  signal: AbortSignal,
): Promise<number | undefined> => {
  const entries = await withinSignal(async () => await readdir("/proc"), signal);
  const candidates = entries.filter((entry) => PROCESS_ID.test(entry));

  const commandLines = await Promise.all(
    candidates.map(async (pid) => {
      signal.throwIfAborted();

      return { args: await readCommandLine(pid, signal), pid: Number(pid) };
    }),
  );

  signal.throwIfAborted();

  return commandLines.find(
    ({ args }) => args.includes(marker) && !args.some((arg) => arg.startsWith("--type=")),
  )?.pid;
};

const psBrowserPid = async (marker: string, signal: AbortSignal): Promise<number | undefined> => {
  signal.throwIfAborted();
  const ps = spawn("ps", ["-axww", "-o", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });

  const kill = () => {
    ps.kill("SIGKILL");
  };

  signal.addEventListener("abort", kill, { once: true });

  try {
    const [listing] = await withinSignal(
      async () => await Promise.all([text(ps.stdout), once(ps, "close")]),
      signal,
    );

    const line = listing
      .split("\n")
      .find((entry) => entry.includes(` ${marker} `) && !entry.includes(" --type="));

    return line === undefined ? undefined : Number(line.trim().split(" ", 1)[0]);
  } finally {
    signal.removeEventListener("abort", kill);

    if (signal.aborted) {
      kill();
    }
  }
};

type ProcessScan = { completed: true; pid: number | undefined } | { completed: false };

const scanBrowserPid = async (
  profileDir: string,
  budgetMs: number,
  parent?: AbortSignal,
): Promise<ProcessScan> => {
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = parent === undefined ? timeout : AbortSignal.any([timeout, parent]);
  const marker = `--user-data-dir=${profileDir}`;

  try {
    const pid = await withinSignal(
      async () =>
        process.platform === "linux"
          ? await linuxBrowserPid(marker, signal)
          : await psBrowserPid(marker, signal),
      signal,
    );

    return { completed: true, pid };
  } catch (error) {
    if (timeout.aborted) {
      return { completed: false };
    }

    throw error;
  }
};

export const findBrowserPid = async (
  profileDir: string,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<number | undefined> => {
  const scan = await scanBrowserPid(profileDir, budgetMs, signal);

  return scan.completed ? scan.pid : undefined;
};

const browserStopped = async (directory: string): Promise<boolean> => {
  const scan = await scanBrowserPid(directoriesIn(directory).profile, PROCESS_SCAN_BUDGET_MS);

  if (!scan.completed) {
    return false;
  }

  if (scan.pid === undefined) {
    return true;
  }

  killProcessGroup(scan.pid);

  return await waitForExit(scan.pid);
};

const removeIfAbandoned = async (directory: string, now: number): Promise<boolean> => {
  const owner = await readOwner(directory);

  const isAbandoned =
    owner !== undefined && now - owner.createdAt > ABANDONED_AFTER_MS && !isAlive(owner.pid);

  if (!isAbandoned || !(await browserStopped(directory))) {
    return false;
  }

  await rm(directory, { force: true, recursive: true });

  return true;
};

export const sweepAbandonedScratch = async (root: string, now: number): Promise<string[]> => {
  await ensureScratchRoot(root);
  const entries = await listEntries(root);

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));

  const removed = await Promise.all(
    directories.map(async (directory) =>
      (await removeIfAbandoned(directory, now)) ? [directory] : [],
    ),
  );

  return removed.flat();
};
