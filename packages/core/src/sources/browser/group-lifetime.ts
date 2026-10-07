import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { withinSignal } from "./lifetime.ts";

const EXIT_POLL_MS = 25;

const LEADERLESS_POLLS_PER_SCAN = 4;

const COMMAND_END = ") ";

const STAT_STATE = 0;

const STAT_GROUP = 2;

const STAT_THREADS = 17;

const ZOMBIE_THREAD_COUNT = 1;

const EXITED_STATES = new Set(["Z", "X", "x"]);

const PROCESS_ID = /^\d+$/u;

const IGNORED_KILL_FAILURES = new Set<unknown>(["ESRCH", "EPERM"]);

const VANISHED_PROCESS_FAILURES = new Set<unknown>(["ENOENT", "ESRCH"]);

interface ProcessState {
  readonly group: number;
  readonly live: boolean;
}

type GroupPresence = "empty" | "live" | "leaderless";

type GroupGoneCheck = (signal: AbortSignal) => Promise<boolean>;

const groupIdHeld = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && IGNORED_KILL_FAILURES.has(error.code))) {
      throw error;
    }

    return error.code === "EPERM";
  }
};

const parseProcessState = (stat: string): ProcessState => {
  const fields = stat.slice(stat.lastIndexOf(COMMAND_END) + COMMAND_END.length).split(" ");

  const exited =
    EXITED_STATES.has(fields[STAT_STATE] ?? "") &&
    Number(fields[STAT_THREADS]) <= ZOMBIE_THREAD_COUNT;

  return { group: Number(fields[STAT_GROUP]), live: !exited };
};

const readProcessState = async (
  pid: number | string,
  signal: AbortSignal,
): Promise<ProcessState | undefined> => {
  try {
    return parseProcessState(await readFile(`/proc/${pid}/stat`, { encoding: "utf-8", signal }));
  } catch (error) {
    if (error instanceof Error && "code" in error && VANISHED_PROCESS_FAILURES.has(error.code)) {
      return undefined;
    }

    throw error;
  }
};

const livesInGroup = (state: ProcessState | undefined, pgid: number): boolean =>
  state?.live === true && state.group === pgid;

const groupPresence = async (pgid: number, signal: AbortSignal): Promise<GroupPresence> => {
  if (!groupIdHeld(pgid)) {
    return "empty";
  }

  if (process.platform !== "linux") {
    return "live";
  }

  return livesInGroup(await readProcessState(pgid, signal), pgid) ? "live" : "leaderless";
};

const liveMemberRemains = async (pgid: number, signal: AbortSignal): Promise<boolean> => {
  const entries = await withinSignal(async () => await readdir("/proc"), signal);
  const pids = entries.filter((entry) => PROCESS_ID.test(entry));
  const states = await Promise.all(pids.map(async (pid) => await readProcessState(pid, signal)));

  signal.throwIfAborted();

  return states.some((state) => livesInGroup(state, pgid));
};

const watchGroupExit = (pgid: number): GroupGoneCheck => {
  let leaderlessPolls = 0;

  return async (signal) => {
    const presence = await groupPresence(pgid, signal);

    if (presence !== "leaderless") {
      return presence === "empty";
    }

    leaderlessPolls += 1;

    return (
      leaderlessPolls % LEADERLESS_POLLS_PER_SCAN === 0 && !(await liveMemberRemains(pgid, signal))
    );
  };
};

const untilGroupGone = async (
  pgid: number,
  signal: AbortSignal,
  betweenPolls?: (pgid: number) => void,
): Promise<boolean> => {
  const groupGone = watchGroupExit(pgid);

  try {
    signal.throwIfAborted();

    // oxlint-disable-next-line eslint/no-await-in-loop -- group membership has no exit event after its leader dies.
    while (!(await groupGone(signal))) {
      betweenPolls?.(pgid);
      // oxlint-disable-next-line eslint/no-await-in-loop -- group membership has no exit event after its leader dies.
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

export const killProcessGroup = (pgid: number): void => {
  if (!groupIdHeld(pgid)) {
    return;
  }

  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && IGNORED_KILL_FAILURES.has(error.code))) {
      throw error;
    }
  }
};

export const waitForGroupExit = async (pgid: number, signal: AbortSignal): Promise<boolean> =>
  await untilGroupGone(pgid, signal);

export const retireProcessGroup = async (pgid: number, signal: AbortSignal): Promise<boolean> =>
  await untilGroupGone(pgid, signal, killProcessGroup);
