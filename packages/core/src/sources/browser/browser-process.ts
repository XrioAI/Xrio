import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Dirent } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";

import { directoriesIn } from "./launch-plan.ts";
import type { LaunchPlan } from "./launch-plan.ts";

const OWNER_FILE = "xrio-owner.json";

const ABANDONED_AFTER_MS = 60 * 60 * 1000;

const EXIT_WAIT_MS = 5000;

const EXIT_POLL_MS = 25;

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

export const removeScratchDir = async ({ path: directory, root }: ScratchDir): Promise<void> => {
  const owner = await readOwner(directory);

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

const linuxProcessState = async (
  pid: string,
): Promise<{ state: string; group: number } | undefined> => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf-8");
    const [state = "", , group = ""] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");

    return { group: Number(group), state };
  } catch {
    return undefined;
  }
};

const isRunning = (entry: { state: string } | undefined): boolean =>
  entry !== undefined && !EXITED_STATES.has(entry.state);

const linuxStillRunning = async (pid: number): Promise<boolean> => {
  const entries = await readdir("/proc");

  const members = await Promise.all(
    entries.filter((entry) => PROCESS_ID.test(entry)).map(linuxProcessState),
  );

  return (
    isRunning(await linuxProcessState(String(pid))) ||
    members.some((member) => member?.group === pid && isRunning(member))
  );
};

const stillRunning = async (pid: number): Promise<boolean> =>
  process.platform === "linux" ? await linuxStillRunning(pid) : isAlive(pid) || isAlive(-pid);

export const waitForExit = async (pid: number): Promise<boolean> => {
  const started = performance.now();

  // oxlint-disable-next-line eslint/no-await-in-loop -- a process known only by its pid has no exit event to await.
  while ((await stillRunning(pid)) && performance.now() - started < EXIT_WAIT_MS) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a process known only by its pid has no exit event to await.
    await delay(EXIT_POLL_MS);
  }

  return !(await stillRunning(pid));
};

const readCommandLine = async (pid: string): Promise<string[]> => {
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf-8");

    return commandLine.split("\0");
  } catch {
    return [];
  }
};

const linuxBrowserPid = async (marker: string): Promise<number | undefined> => {
  const entries = await readdir("/proc");
  const candidates = entries.filter((entry) => PROCESS_ID.test(entry));

  const commandLines = await Promise.all(
    candidates.map(async (pid) => ({ args: await readCommandLine(pid), pid: Number(pid) })),
  );

  return commandLines.find(
    ({ args }) => args.includes(marker) && !args.some((arg) => arg.startsWith("--type=")),
  )?.pid;
};

const psBrowserPid = async (marker: string): Promise<number | undefined> => {
  const ps = spawn("ps", ["-axww", "-o", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
  const [listing] = await Promise.all([text(ps.stdout), once(ps, "close")]);

  const line = listing
    .split("\n")
    .find((entry) => entry.includes(` ${marker} `) && !entry.includes(" --type="));

  return line === undefined ? undefined : Number(line.trim().split(" ", 1)[0]);
};

export const findBrowserPid = async (profileDir: string): Promise<number | undefined> => {
  const marker = `--user-data-dir=${profileDir}`;

  return process.platform === "linux" ? await linuxBrowserPid(marker) : await psBrowserPid(marker);
};

const browserStopped = async (directory: string): Promise<boolean> => {
  const pid = await findBrowserPid(directoriesIn(directory).profile);

  if (pid === undefined) {
    return true;
  }

  killProcessGroup(pid);

  return await waitForExit(pid);
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
