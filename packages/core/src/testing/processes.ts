import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";

interface ProcessEntry {
  pid: number;
  command: string;
}

interface ScratchUser {
  pid: number;
  directory: string;
}

const PATH_END = /[\s/]/u;

const USER_DATA_DIR = /--user-data-dir=(?<profile>\S+)/u;

const PROCESS_LINE = /^\s*(?<pid>\d+)\s(?<command>.*)$/u;

const processTable = async (): Promise<ProcessEntry[]> => {
  const ps = spawn("ps", ["-axww", "-o", "pid=,command="], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  const [listing] = await Promise.all([text(ps.stdout), once(ps, "close")]);

  return listing.split("\n").flatMap((line) => {
    const fields = PROCESS_LINE.exec(line)?.groups;

    return fields === undefined ? [] : [{ command: fields.command ?? "", pid: Number(fields.pid) }];
  });
};

export const profileOf = async (pid: number): Promise<string | undefined> => {
  const table = await processTable();
  const entry = table.find((candidate) => candidate.pid === pid);

  return entry === undefined ? undefined : USER_DATA_DIR.exec(entry.command)?.groups?.profile;
};

export const commandLineOf = async (pid: number): Promise<string> => {
  const table = await processTable();

  return table.find((candidate) => candidate.pid === pid)?.command ?? "";
};

export const noProcessUses = async (directory: string): Promise<boolean> => {
  const table = await processTable();

  return !table.some(({ command }) => command.includes(directory));
};

export const scratchUsers = async (root: string): Promise<ScratchUser[]> => {
  const table = await processTable();
  const prefix = `${root}/`;

  return table.flatMap(({ command, pid }) => {
    const start = command.indexOf(prefix);
    const [name = ""] = start === -1 ? [] : command.slice(start + prefix.length).split(PATH_END, 1);

    return name === "" ? [] : [{ directory: `${prefix}${name}`, pid }];
  });
};

export const killRenderers = async (profile: string): Promise<number> => {
  const table = await processTable();

  const renderers = table.filter(
    ({ command }) => command.includes("--type=renderer") && command.includes(profile),
  );

  for (const { pid } of renderers) {
    process.kill(pid, "SIGKILL");
  }

  return renderers.length;
};
