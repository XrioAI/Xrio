import { subscribe } from "node:diagnostics_channel";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { scratchRoot } from "../sources/browser/browser-process.ts";
import { isLaunchEvent } from "./launch-events.ts";
import { scratchUsers } from "./processes.ts";

const launchedPids: number[] = [];

subscribe("xrio:event", (message) => {
  if (isLaunchEvent(message)) {
    launchedPids.push(Number(message.detail));
  }
});

const hasPid = (value: unknown): value is { pid: number } =>
  typeof value === "object" && value !== null && "pid" in value && typeof value.pid === "number";

const ownerPidOf = async (directory: string): Promise<number | undefined> => {
  try {
    const owner: unknown = JSON.parse(
      await readFile(path.join(directory, "xrio-owner.json"), "utf-8"),
    );

    return hasPid(owner) ? owner.pid : undefined;
  } catch {
    return undefined;
  }
};

const ownedScratchDirs = async (): Promise<string[]> => {
  const entries = await readdir(scratchRoot());

  const owned = await Promise.all(
    entries.map(async (entry) =>
      (await ownerPidOf(path.join(scratchRoot(), entry))) === process.pid ? [entry] : [],
    ),
  );

  return owned.flat();
};

export const lastLaunchedPid = (): number | undefined => launchedPids.at(-1);

const isOursOrGone = async (directory: string): Promise<boolean> =>
  !existsSync(directory) || (await ownerPidOf(directory)) === process.pid;

const processesInOurScratch = async (): Promise<number[]> => {
  const users = await scratchUsers(scratchRoot());

  const ours = await Promise.all(
    users.map(async ({ directory, pid }) => ((await isOursOrGone(directory)) ? [pid] : [])),
  );

  return ours.flat();
};

export const leftovers = async () => ({
  directories: await ownedScratchDirs(),
  processes: await processesInOurScratch(),
});

export const nothingLeft = { directories: [], processes: [] };
