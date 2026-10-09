import { createHash } from "node:crypto";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { hostCacheRoot } from "../../cache-dir.ts";
import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import type { FontEvidence, HostCapabilities } from "../../humanizer/contracts.ts";
import type { FontEvidenceOutcome } from "../../humanizer/verify.ts";
import { ensureScratchRoot, writeAtomically } from "./browser-process.ts";

const EVIDENCE_FORMAT = 1;

const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

const GATHERER_WAIT_MS = 5000;

const UNPROVEN_TTL_MS = 60_000;

export interface FontClaim {
  readonly evidence: FontEvidence | undefined;
  readonly settle: (outcome: FontEvidenceOutcome | null) => Promise<void>;
}

export interface FontEvidenceStore {
  readonly claim: (
    browserPath: string,
    capabilities: HostCapabilities,
    locale: string,
    deadline: Deadline,
  ) => Promise<FontClaim>;
}

interface EvidenceOptions {
  readonly gathererWaitMs: number;
  readonly now: () => number;
  readonly root: string;
  readonly signal: AbortSignal;
}

interface StoredEvidence {
  readonly format: typeof EVIDENCE_FORMAT;
  readonly gatheredAt: number;
  readonly digest: string;
  readonly sentinel: string;
}

type Gathered = Extract<FontEvidenceOutcome, { kind: "gathered" }>;

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStoredEvidence = (value: unknown): value is StoredEvidence =>
  isObject(value) &&
  "format" in value &&
  value.format === EVIDENCE_FORMAT &&
  "gatheredAt" in value &&
  typeof value.gatheredAt === "number" &&
  Number.isFinite(value.gatheredAt) &&
  "digest" in value &&
  typeof value.digest === "string" &&
  "sentinel" in value &&
  typeof value.sentinel === "string";

const keyOf = async (
  browserPath: string,
  { fontStack, platform }: HostCapabilities,
  locale: string,
): Promise<string | undefined> => {
  try {
    const binary = await realpath(browserPath);
    const { dev, ino, mtimeMs, size } = await stat(binary);
    const fonts = fontStack?.kind === "checked" ? [fontStack.directory, fontStack.payload] : "host";

    return createHash("sha256")
      .update(JSON.stringify([platform, binary, dev, ino, size, mtimeMs, fonts, locale]))
      .digest("hex");
  } catch {
    return undefined;
  }
};

const readStored = async (file: string): Promise<StoredEvidence | undefined> => {
  let stored: unknown;

  try {
    stored = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }

  return isStoredEvidence(stored) ? stored : undefined;
};

const NO_CLAIM: FontClaim = {
  evidence: undefined,
  settle: async () => {
    await Promise.resolve();
  },
};

const attempt = async (work: () => Promise<void>): Promise<boolean> => {
  try {
    await work();

    return true;
  } catch {
    return false;
  }
};

export const createFontEvidenceStore = (
  overrides: Partial<EvidenceOptions> = {},
): FontEvidenceStore => {
  const options: EvidenceOptions = {
    gathererWaitMs: GATHERER_WAIT_MS,
    now: Date.now,
    root: hostCacheRoot(),
    signal: new AbortController().signal,
    ...overrides,
  };

  const kept = new Map<string, StoredEvidence>();
  const gathering = new Map<string, Promise<null>>();
  const unproven = new Map<string, number>();

  const fileOf = (key: string): string => path.join(options.root, `font-evidence-${key}.json`);

  const isFresh = ({ gatheredAt }: StoredEvidence): boolean => {
    const age = options.now() - gatheredAt;

    return age >= 0 && age < EVIDENCE_TTL_MS;
  };

  const isUnproven = (key: string): boolean => {
    const age = options.now() - (unproven.get(key) ?? Number.NEGATIVE_INFINITY);

    return age >= 0 && age < UNPROVEN_TTL_MS;
  };

  const lookup = async (key: string): Promise<FontEvidence | undefined> => {
    const stored = kept.get(key) ?? (await readStored(fileOf(key)));

    if (stored === undefined || !isFresh(stored)) {
      kept.delete(key);

      return undefined;
    }

    kept.set(key, stored);

    return {
      ageMs: options.now() - stored.gatheredAt,
      digest: stored.digest,
      key,
      sentinel: stored.sentinel,
    };
  };

  const keep = async (key: string, { digest, sentinel }: Gathered): Promise<void> => {
    const stored: StoredEvidence = {
      digest,
      format: EVIDENCE_FORMAT,
      gatheredAt: options.now(),
      sentinel,
    };

    kept.set(key, stored);
    unproven.delete(key);

    await attempt(async () => {
      await ensureScratchRoot(options.root);
      await writeAtomically(fileOf(key), JSON.stringify(stored));
    });
  };

  const invalidate = async (key: string): Promise<void> => {
    kept.delete(key);
    await attempt(async () => {
      await rm(fileOf(key), { force: true });
    });
  };

  const keptClaim = (key: string, evidence: FontEvidence): FontClaim => {
    let settled = false;

    return {
      evidence,
      settle: async (outcome) => {
        if (settled) {
          return;
        }

        settled = true;

        if (outcome?.kind === "drifted") {
          await invalidate(key);
        }
      },
    };
  };

  const gatheringClaim = (key: string, release?: () => void): FontClaim => {
    let settled = false;

    return {
      evidence: undefined,
      settle: async (outcome) => {
        if (settled) {
          return;
        }

        settled = true;

        try {
          if (outcome?.kind === "gathered") {
            await keep(key, outcome);
          } else if (outcome?.kind === "unproven") {
            unproven.set(key, options.now());
          }
        } finally {
          release?.();
        }
      },
    };
  };

  const gathererSettled = async (gatherer: Promise<null>, deadline: Deadline): Promise<boolean> => {
    const waiting = new AbortController();

    try {
      return await untilDeadline(
        async () =>
          await Promise.race([
            gatherer.then(() => true),
            delay(options.gathererWaitMs, false, {
              signal: AbortSignal.any([waiting.signal, options.signal]),
            }).catch(() => false),
          ]),
        deadline,
      );
    } finally {
      waiting.abort();
    }
  };

  const claimKey = async (key: string, deadline: Deadline): Promise<FontClaim> => {
    const evidence = await lookup(key);

    if (evidence !== undefined) {
      return keptClaim(key, evidence);
    }

    if (isUnproven(key)) {
      return NO_CLAIM;
    }

    const gatherer = gathering.get(key);

    if (gatherer !== undefined) {
      return (await gathererSettled(gatherer, deadline))
        ? await claimKey(key, deadline)
        : gatheringClaim(key);
    }

    const owned = Promise.withResolvers<null>();

    gathering.set(key, owned.promise);

    return gatheringClaim(key, () => {
      gathering.delete(key);
      owned.resolve(null);
    });
  };

  const claim: FontEvidenceStore["claim"] = async (browserPath, capabilities, locale, deadline) => {
    const key = await keyOf(browserPath, capabilities, locale);

    if (key === undefined) {
      return NO_CLAIM;
    }

    try {
      return await claimKey(key, deadline);
    } catch {
      deadline.throwIfExpired();

      return NO_CLAIM;
    }
  };

  return { claim };
};
