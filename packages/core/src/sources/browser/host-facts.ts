import { hostCacheRoot } from "../../cache-dir.ts";
import type { CacheDir } from "../../cache-dir.ts";
import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import type { HostCapabilities } from "../../humanizer/contracts.ts";
import { scratchRoot } from "./browser-process.ts";
import { createCapabilityProbe, createProbeWork, PROBE_SETTLE_BUDGET_MS } from "./capabilities.ts";
import type { HostCapabilityProbe } from "./capabilities.ts";
import { settleWithin } from "./lifetime.ts";

export interface HostFacts {
  readonly snapshotFor: (
    binary: string | undefined,
    deadline: Deadline,
  ) => Promise<HostCapabilities>;
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

  return {
    settle: async () => {
      await settleWithin(work.settled(), PROBE_SETTLE_BUDGET_MS);
    },
    snapshotFor: async (binary, deadline) => {
      deadline.throwIfExpired();

      return await untilDeadline(async () => await probe(binary, deadline, work), deadline);
    },
  };
};
