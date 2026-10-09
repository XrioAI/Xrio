import { hostCacheRoot } from "../../cache-dir.ts";
import type { CacheDir } from "../../cache-dir.ts";
import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import type { HostCapabilities } from "../../humanizer/contracts.ts";
import { scratchRoot } from "./browser-process.ts";
import {
  chromeMajorOf,
  createCapabilityProbe,
  createProbeWork,
  PROBE_SETTLE_BUDGET_MS,
  readChromeVersion,
} from "./capabilities.ts";
import type { HostCapabilityProbe } from "./capabilities.ts";
import { settleWithin } from "./lifetime.ts";

export interface HostFacts {
  readonly snapshotFor: (
    binary: string | undefined,
    deadline: Deadline,
  ) => Promise<HostCapabilities>;
  readonly chromeMajorFor: (
    binary: string,
    capabilities: HostCapabilities,
    deadline: Deadline,
  ) => Promise<number>;
}

export interface ClientHostFacts extends HostFacts {
  readonly settle: () => Promise<void>;
}

const processProbes = new Map<string, HostCapabilityProbe>();

const shutdown = new AbortController();

process.once("exit", () => {
  shutdown.abort();
});

const processProbeFor = (root: string): HostCapabilityProbe => {
  const known = processProbes.get(root);

  if (known !== undefined) {
    return known;
  }

  const probe = createCapabilityProbe({
    root,
    scratchRoot: scratchRoot(),
    signal: shutdown.signal,
  });

  processProbes.set(root, probe);

  return probe;
};

export const hostFactsFor = (cacheDir: CacheDir): ClientHostFacts => {
  const probe = processProbeFor(hostCacheRoot(cacheDir));
  const work = createProbeWork();
  const versions = new Map<string, Promise<string>>();
  const versionWork = new AbortController();

  const versionFor = async (binary: string): Promise<string> => {
    const known = versions.get(binary);

    if (known !== undefined) {
      return await known;
    }

    const reading = readChromeVersion(binary, versionWork.signal);

    versions.set(binary, reading);

    try {
      return await reading;
    } catch (error) {
      if (versions.get(binary) === reading) {
        versions.delete(binary);
      }

      throw error;
    }
  };

  return {
    chromeMajorFor: async (binary, capabilities, deadline) =>
      chromeMajorOf(
        capabilities.fork?.version ??
          (await untilDeadline(async () => await versionFor(binary), deadline)),
      ),
    settle: async () => {
      versionWork.abort();
      await settleWithin(
        Promise.allSettled([work.settled(), ...versions.values()]),
        PROBE_SETTLE_BUDGET_MS,
      );
    },
    snapshotFor: async (binary, deadline) => {
      deadline.throwIfExpired();

      return await untilDeadline(async () => await probe(binary, deadline, work), deadline);
    },
  };
};
