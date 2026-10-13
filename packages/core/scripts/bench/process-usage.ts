import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";

const SAMPLE_INTERVAL_MS = 50;

const BYTES_PER_MIB = 1024 * 1024;

const MICROSECONDS_PER_SECOND = 1_000_000;

const FIELDS_AFTER_COMM_OFFSET = 2;

const PROCESS_GROUP_FIELD = 2;

const USER_TICKS_FIELD = 11;

const SYSTEM_TICKS_FIELD = 12;

const RESIDENT_PAGES_FIELD = 21;

export interface BrowserUsage {
  readonly cpuSeconds: number;
  readonly peakRssMib: number;
  readonly processes: number;
}

export interface UsageReport {
  readonly nodeCpuSeconds: number;
  readonly nodePeakRssMib: number;
  readonly browser: BrowserUsage | null;
  readonly combinedPeakRssMib: number | null;
}

interface GroupMember {
  readonly ticks: number;
  readonly residentPages: number;
}

const readIfAlive = <Value>(read: () => Value): Value | undefined => {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    ) {
      return undefined;
    }

    throw error;
  }
};

const getconf = (name: string): number => Number(execFileSync("getconf", [name]).toString().trim());

const memberOf = (pid: number, leader: number): GroupMember | undefined => {
  const stat = readIfAlive(() => readFileSync(`/proc/${pid}/stat`, "utf-8"));

  if (stat === undefined) {
    return undefined;
  }

  const fields = stat.slice(stat.lastIndexOf(")") + FIELDS_AFTER_COMM_OFFSET).split(" ");

  if (Number(fields[PROCESS_GROUP_FIELD]) !== leader) {
    return undefined;
  }

  return {
    residentPages: Number(fields[RESIDENT_PAGES_FIELD]),
    ticks: Number(fields[USER_TICKS_FIELD]) + Number(fields[SYSTEM_TICKS_FIELD]),
  };
};

const createGroupReader = (leader: number) => {
  const outsideGroup = new Set<number>();
  const uid = process.getuid?.();

  const candidatePids = (): number[] =>
    readdirSync("/proc")
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && !outsideGroup.has(pid));

  const isOwn = (pid: number): boolean => {
    const owner = readIfAlive(() => statSync(`/proc/${pid}`).uid);

    return owner !== undefined && owner === uid;
  };

  return (): Map<number, GroupMember> => {
    const members = new Map<number, GroupMember>();

    for (const pid of candidatePids()) {
      const member = isOwn(pid) ? memberOf(pid, leader) : undefined;

      if (member === undefined) {
        outsideGroup.add(pid);
      } else {
        members.set(pid, member);
      }
    }

    return members;
  };
};

const createBrowserLedger = (leader: number) => {
  const readGroup = createGroupReader(leader);
  const ticksSeen = new Map<number, number>();
  const pageSize = getconf("PAGESIZE");
  const ticksPerSecond = getconf("CLK_TCK");
  let peakPages = 0;

  return {
    peakRssBytes: (): number => peakPages * pageSize,
    report: (): Omit<BrowserUsage, "peakRssMib"> => ({
      cpuSeconds: [...ticksSeen.values()].reduce((sum, ticks) => sum + ticks, 0) / ticksPerSecond,
      processes: ticksSeen.size,
    }),
    sample: (): number => {
      let pages = 0;

      for (const [pid, member] of readGroup()) {
        pages += member.residentPages;
        ticksSeen.set(pid, Math.max(ticksSeen.get(pid) ?? 0, member.ticks));
      }

      peakPages = Math.max(peakPages, pages);

      return pages * pageSize;
    },
  };
};

export const startUsageMeter = () => {
  const cpuAtStart = process.cpuUsage();
  const canReadGroup = process.platform === "linux";
  let ledger: ReturnType<typeof createBrowserLedger> | undefined;
  let peakNodeBytes = 0;
  let peakCombinedBytes = 0;

  const sample = (): void => {
    const nodeBytes = process.memoryUsage.rss();
    const browserBytes = ledger?.sample() ?? 0;

    peakNodeBytes = Math.max(peakNodeBytes, nodeBytes);
    peakCombinedBytes = Math.max(peakCombinedBytes, nodeBytes + browserBytes);
  };

  sample();
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);

  timer.unref();

  return {
    finish: (): UsageReport => {
      clearInterval(timer);
      sample();
      const cpu = process.cpuUsage(cpuAtStart);
      const browser = ledger?.report();

      return {
        browser:
          ledger === undefined || browser === undefined
            ? null
            : { ...browser, peakRssMib: ledger.peakRssBytes() / BYTES_PER_MIB },
        combinedPeakRssMib: ledger === undefined ? null : peakCombinedBytes / BYTES_PER_MIB,
        nodeCpuSeconds: (cpu.user + cpu.system) / MICROSECONDS_PER_SECOND,
        nodePeakRssMib: peakNodeBytes / BYTES_PER_MIB,
      };
    },
    followBrowser: (pid: number): void => {
      if (canReadGroup) {
        ledger = createBrowserLedger(pid);
      }
    },
    sample,
  };
};

export type UsageMeter = ReturnType<typeof startUsageMeter>;
