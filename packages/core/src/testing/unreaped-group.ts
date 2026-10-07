import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { killProcessGroup } from "../sources/browser/group-lifetime.ts";

const LEADER_ARGUMENT = "XRIO_UNREAPED_LEADER_ARGUMENT";

const UNREAPED_GROUP = `
import ctypes, os, sys
libc = ctypes.CDLL(None)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise RuntimeError('cannot become child subreaper')
leader_fate = sys.argv[1]
read, write = os.pipe()
leader = os.fork()
if leader == 0:
    os.close(read)
    os.setsid()
    member = os.fork()
    if member == 0:
        libc.prctl(15, f'z) S 1 {os.getpgrp()} '.encode(), 0, 0, 0)
        os._exit(0)
    os.write(write, str(member).encode())
    if leader_fate == 'running':
        os.set_inheritable(write, True)
        os.execvp(sys.executable, [
            sys.executable,
            '-c',
            'import os, sys, time; os.close(int(sys.argv[1])); time.sleep(60)',
            str(write),
            os.environ['${LEADER_ARGUMENT}'],
        ])
    os._exit(0)
os.close(write)
member = int(os.read(read, 32))
os.read(read, 1)
os.close(read)
if leader_fate == 'reaped':
    os.waitpid(leader, 0)
elif leader_fate == 'zombie':
    os.waitid(os.P_PID, leader, os.WEXITED | os.WNOWAIT)
if leader_fate != 'running':
    os.waitid(os.P_PID, member, os.WEXITED | os.WNOWAIT)
print(leader, member, flush=True)
sys.stdin.read()
`;

const STAT_TAIL = /\) (?<state>\S) \d+ (?<group>\d+) [^)]*$/u;

export type UnreapedLeader =
  | { readonly leader: "reaped" | "zombie" }
  | { readonly leader: "running"; readonly argument: string };

export interface UnreapedGroup extends AsyncDisposable {
  readonly leader: number;
  readonly member: number;
}

interface ProcessReading {
  readonly group: number;
  readonly state: string;
}

const environmentFor = (fate: UnreapedLeader): NodeJS.ProcessEnv =>
  fate.leader === "running" ? { ...process.env, [LEADER_ARGUMENT]: fate.argument } : process.env;

export const holdUnreapedGroup = async (fate: UnreapedLeader): Promise<UnreapedGroup> => {
  const holder = spawn("python3", ["-c", UNREAPED_GROUP, fate.leader], {
    env: environmentFor(fate),
    stdio: ["pipe", "pipe", "inherit"],
  });

  const closed = once(holder, "close");
  const pieces: readonly unknown[] = await once(holder.stdout, "data");
  const [output] = pieces;
  const [leader = Number.NaN, member = Number.NaN] = String(output).trim().split(" ").map(Number);

  return {
    [Symbol.asyncDispose]: async () => {
      killProcessGroup(leader);
      holder.stdin.end();
      await closed;
    },
    leader,
    member,
  };
};

export const processStateOf = async (pid: number): Promise<ProcessReading | undefined> => {
  try {
    const fields = STAT_TAIL.exec(await readFile(`/proc/${pid}/stat`, "utf-8"))?.groups;

    return { group: Number(fields?.group), state: fields?.state ?? "" };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};
