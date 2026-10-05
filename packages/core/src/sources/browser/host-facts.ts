import { hostCacheRoot } from "../../cache-dir.ts";
import type { CacheDir } from "../../cache-dir.ts";
import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import type { HostCapabilities } from "../../humanizer/contracts.ts";
import { scratchRoot } from "./browser-process.ts";
import { createCapabilityProbe, PROBE_SETTLE_BUDGET_MS } from "./capabilities.ts";
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
  const probing = new Set<Promise<HostCapabilities>>();

  const trackUntilSettled = async (snapshot: Promise<HostCapabilities>): Promise<void> => {
    probing.add(snapshot);
    await Promise.allSettled([snapshot]);
    probing.delete(snapshot);
  };

  return {
    settle: async () => {
      await settleWithin(Promise.allSettled(probing), PROBE_SETTLE_BUDGET_MS);
    },
    snapshotFor: async (binary, deadline) => {
      deadline.throwIfExpired();

      const snapshot = probe(binary);

      void trackUntilSettled(snapshot);

      return await untilDeadline(async () => await snapshot, deadline);
    },
  };
};
