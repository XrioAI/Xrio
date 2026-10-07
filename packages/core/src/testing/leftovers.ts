import { subscribe } from "node:diagnostics_channel";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

const ownerPidOf = (directory: string): number | undefined => {
  try {
    const owner: unknown = JSON.parse(
      readFileSync(path.join(directory, "xrio-owner.json"), "utf-8"),
    );

    return hasPid(owner) ? owner.pid : undefined;
  } catch {
    return undefined;
  }
};

export const ownedScratchDirs = (): string[] =>
  readdirSync(scratchRoot()).filter(
    (entry) => ownerPidOf(path.join(scratchRoot(), entry)) === process.pid,
  );

export const lastLaunchedPid = (): number | undefined => launchedPids.at(-1);

const isOursOrGone = (directory: string): boolean =>
  !existsSync(directory) || ownerPidOf(directory) === process.pid;

const processesInOurScratch = async (): Promise<number[]> => {
  const users = await scratchUsers(scratchRoot());

  return users.flatMap(({ directory, pid }) => (isOursOrGone(directory) ? [pid] : []));
};

export const leftovers = async () => ({
  directories: ownedScratchDirs(),
  processes: await processesInOurScratch(),
});

export const nothingLeft = { directories: [], processes: [] };
