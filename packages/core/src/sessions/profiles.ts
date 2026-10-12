import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readdirSync, renameSync, rmSync } from "node:fs";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";

import { invalidOptions } from "../errors.ts";

export const LOCAL_TENANT = "local";

const TOMBSTONE_MARKER = ".removed-";

const STAT_START_TIME_FIELD = 22;

const STAT_FIRST_FIELD_AFTER_COMMAND = 3;

const xdgStateHome = (): string => {
  const configured = process.env.XDG_STATE_HOME;

  return configured === undefined || configured === ""
    ? path.join(homedir(), ".local", "state")
    : configured;
};

export const defaultStateDir = (): string =>
  process.platform === "darwin"
    ? path.join(homedir(), "Library", "Application Support", "xrio")
    : path.join(xdgStateHome(), "xrio");

export const defaultDatabaseDir = (): string => path.join(homedir(), ".xrio");

const PROFILES = "profiles";

const STORED_PROFILE = /^profiles\/[0-9a-f]{16}$/u;

const DISK_CACHE_SWITCH = "--disk-cache-dir=";

const profilesRoot = (root: string): string => path.join(root, PROFILES);

export const storedProfile = (tenant: string, name: string): string =>
  path.posix.join(
    PROFILES,
    createHash("sha256")
      .update(JSON.stringify([tenant, name]))
      .digest("hex")
      .slice(0, 16),
  );

export const isStoredProfile = (stored: string): boolean => STORED_PROFILE.test(stored);

export interface CacheHost {
  readonly platform: NodeJS.Platform;
  readonly home: () => string;
}

const LOCAL_HOST: CacheHost = { home: () => userInfo().homedir, platform: process.platform };

const chromeUserCache = (directory: string, host: CacheHost): string | undefined => {
  if (host.platform !== "darwin") {
    return undefined;
  }

  const home = host.home();

  const underApplicationSupport = path.relative(
    path.join(home, "Library", "Application Support"),
    directory,
  );

  const insideApplicationSupport =
    underApplicationSupport !== "" &&
    !underApplicationSupport.startsWith("..") &&
    !path.isAbsolute(underApplicationSupport);

  return insideApplicationSupport
    ? path.join(home, "Library", "Caches", underApplicationSupport)
    : undefined;
};

const chosenDiskCache = (browserArgs: readonly string[]): string | undefined =>
  browserArgs
    .findLast((arg) => arg.startsWith(DISK_CACHE_SWITCH) && arg.length > DISK_CACHE_SWITCH.length)
    ?.slice(DISK_CACHE_SWITCH.length);

export const cacheDirectory = (
  profileDir: string,
  browserArgs: readonly string[],
  host: CacheHost = LOCAL_HOST,
): string => {
  const diskCache = chosenDiskCache(browserArgs);
  const profile = path.join(profileDir, "Default");

  const cacheProfile =
    diskCache === undefined
      ? (chromeUserCache(profile, host) ?? profile)
      : path.resolve(diskCache, "Default");

  return path.join(cacheProfile, "Cache");
};

export const cacheOutsideProfile = (
  profileDir: string,
  browserArgs: readonly string[],
  host: CacheHost = LOCAL_HOST,
): string | undefined =>
  chosenDiskCache(browserArgs) === undefined ? chromeUserCache(profileDir, host) : undefined;

export const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stats = await lstat(directory);

  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== (process.getuid?.() ?? 0) ||
    stats.mode % 0o100 !== 0
  ) {
    throw invalidOptions(
      `The session directory ${directory} must be a directory that this user owns, not a symbolic link, and must grant the group and others no access (mode 0700).`,
    );
  }
};

export const movedProfile = (directory: string) => {
  const tombstone = `${directory}${TOMBSTONE_MARKER}${randomUUID()}`;
  let moved = false;

  return {
    move: () => {
      try {
        renameSync(directory, tombstone);
        moved = true;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    },
    restore: () => {
      if (!moved) {
        return;
      }

      rmSync(directory, { force: true, recursive: true });
      renameSync(tombstone, directory);
      moved = false;
    },
    settle: async () => {
      if (moved) {
        await rm(tombstone, { force: true, recursive: true });
      }
    },
  };
};

export const tombstonesIn = (root: string): string[] => {
  try {
    return readdirSync(profilesRoot(root)).flatMap((name) =>
      name.includes(TOMBSTONE_MARKER) ? [path.join(profilesRoot(root), name)] : [],
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

export interface Holder {
  readonly host: string;
  readonly pid: number;
  readonly start: string;
  readonly token: string;
}

const readPsStart = async (pid: number): Promise<string | undefined> => {
  const child = spawn("ps", ["-p", String(pid), "-o", "lstart="], {
    // oxlint-disable-next-line xrio/identity-owner -- ps renders lstart in its own zone and locale; fixing both makes a start comparable across processes.
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    stdio: ["ignore", "pipe", "ignore"],
  });

  try {
    const [output] = await Promise.all([text(child.stdout), once(child, "close")]);

    return child.exitCode === 0 ? output.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
};

export const processStart = async (pid: number): Promise<string | undefined> => {
  if (process.platform !== "linux") {
    return await readPsStart(pid);
  }

  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf-8");

    const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).split(" ");

    return fieldsAfterCommand[STAT_START_TIME_FIELD - STAT_FIRST_FIELD_AFTER_COMMAND];
  } catch {
    return undefined;
  }
};

export const holderIsGone = async (
  holder: Holder,
  ownStart: string,
  readStart: typeof processStart = processStart,
): Promise<boolean> => {
  if (holder.host !== hostname()) {
    return false;
  }

  if (holder.pid === process.pid) {
    return holder.start !== ownStart;
  }

  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }

  const start = await readStart(holder.pid);

  return start !== undefined && start !== holder.start;
};
