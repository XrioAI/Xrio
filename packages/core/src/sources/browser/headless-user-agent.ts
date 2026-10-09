import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import path from "node:path";

import { startDeadline } from "../../deadline.ts";
import { publishInternalEvent } from "../../diagnostics.ts";
import type { PresentedUserAgent, UserAgentMetadata } from "../../humanizer/contracts.ts";
import {
  createScratchDir,
  prepareProfile,
  removeScratchDir,
  writeAtomically,
} from "./browser-process.ts";
import type { ScratchDir } from "./browser-process.ts";
import { fileIdentityOf } from "./file-identity.ts";
import { retireProcessGroup } from "./group-lifetime.ts";
import { planHeadlessProbe } from "./launch-plan.ts";
import { settleWithin } from "./lifetime.ts";
import { CLEANUP_BUDGET_MS, CLOSE_BUDGET_MS, TEARDOWN_BUDGET_MS } from "./port.ts";
import type { BrowserDriver, DriverBrowser } from "./port.ts";

const USER_AGENT_FORMAT = 1;

const LEARNED_TTL_MS = 24 * 60 * 60 * 1000;

const FAILED_TTL_MS = 60_000;

const HEADLESS_TOKEN = "HeadlessChrome/";

const HEADED_TOKEN = "Chrome/";

const HIGH_ENTROPY_HINTS = [
  "architecture",
  "bitness",
  "formFactors",
  "fullVersionList",
  "model",
  "platformVersion",
  "uaFullVersion",
  "wow64",
] as const;

const USER_AGENT_READ = `(async () => JSON.stringify({
  userAgent: navigator.userAgent,
  hints: await navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HIGH_ENTROPY_HINTS)}),
}))()`;

interface Brand {
  readonly brand: string;
  readonly version: string;
}

interface Hints {
  readonly architecture: string;
  readonly bitness: string;
  readonly brands: readonly Brand[];
  readonly formFactors: readonly string[];
  readonly fullVersionList: readonly Brand[];
  readonly mobile: boolean;
  readonly model: string;
  readonly platform: string;
  readonly platformVersion: string;
  readonly uaFullVersion: string;
  readonly wow64: boolean;
}

interface Reading {
  readonly userAgent: string;
  readonly hints: Hints;
}

type StoredUserAgent =
  | {
      readonly format: typeof USER_AGENT_FORMAT;
      readonly kind: "learned";
      readonly learnedAt: number;
      readonly presented: PresentedUserAgent | null;
    }
  | {
      readonly format: typeof USER_AGENT_FORMAT;
      readonly kind: "failed";
      readonly failedAt: number;
      readonly reason: string;
    };

type Learning =
  | { readonly presented: PresentedUserAgent | undefined }
  | { readonly reason: string };

interface Learned {
  readonly presented: PresentedUserAgent | undefined;
  readonly expiresAt: number;
}

interface UserAgentEntry {
  readonly learned: Promise<Learned>;
  expiresAt?: number;
}

interface HeadlessUserAgentOptions {
  readonly driver: BrowserDriver;
  readonly budgetMs: number;
  readonly now: () => number;
  readonly root: string;
  readonly scratchRoot: string;
  readonly signal: AbortSignal;
}

type HeadlessUserAgentReader = (binary: string) => Promise<PresentedUserAgent | undefined>;

type Guards<Parsed> = {
  readonly [Key in keyof Parsed]-?: (value: unknown) => value is Parsed[Key];
};

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const isText = (value: unknown): value is string => typeof value === "string";

const isFlag = (value: unknown): value is boolean => typeof value === "boolean";

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isTexts = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isText);

const fieldsHold = (
  guards: Readonly<Record<string, (value: unknown) => value is unknown>>,
  fields: ReadonlyMap<string, unknown>,
): boolean => Object.entries(guards).every(([key, isValid]) => isValid(fields.get(key)));

const BRAND = { brand: isText, version: isText } satisfies Guards<Brand>;

const isBrand = (value: unknown): value is Brand =>
  isObject(value) && fieldsHold(BRAND, new Map(Object.entries(value)));

const isBrands = (value: unknown): value is readonly Brand[] =>
  Array.isArray(value) && value.every(isBrand);

const HINTS = {
  architecture: isText,
  bitness: isText,
  brands: isBrands,
  formFactors: isTexts,
  fullVersionList: isBrands,
  mobile: isFlag,
  model: isText,
  platform: isText,
  platformVersion: isText,
  uaFullVersion: isText,
  wow64: isFlag,
} satisfies Guards<Hints>;

const isHints = (value: unknown): value is Hints =>
  isObject(value) && fieldsHold(HINTS, new Map(Object.entries(value)));

const READING = { hints: isHints, userAgent: isText } satisfies Guards<Reading>;

const isReading = (value: unknown): value is Reading =>
  isObject(value) && fieldsHold(READING, new Map(Object.entries(value)));

const METADATA = {
  architecture: isText,
  bitness: isText,
  brands: isBrands,
  formFactors: isTexts,
  fullVersion: isText,
  fullVersionList: isBrands,
  mobile: isFlag,
  model: isText,
  platform: isText,
  platformVersion: isText,
  wow64: isFlag,
} satisfies Guards<UserAgentMetadata>;

const isMetadata = (value: unknown): value is UserAgentMetadata =>
  isObject(value) && fieldsHold(METADATA, new Map(Object.entries(value)));

const PRESENTED = { metadata: isMetadata, userAgent: isText } satisfies Guards<PresentedUserAgent>;

const isPresentedOrNull = (value: unknown): value is PresentedUserAgent | null =>
  value === null || (isObject(value) && fieldsHold(PRESENTED, new Map(Object.entries(value))));

const isStoredUserAgent = (value: unknown): value is StoredUserAgent => {
  if (!isObject(value) || !("format" in value) || value.format !== USER_AGENT_FORMAT) {
    return false;
  }

  const fields = new Map(Object.entries(value));

  const isLearned =
    fields.get("kind") === "learned" &&
    isTime(fields.get("learnedAt")) &&
    isPresentedOrNull(fields.get("presented"));

  const isFailed =
    fields.get("kind") === "failed" &&
    isTime(fields.get("failedAt")) &&
    isText(fields.get("reason"));

  return isLearned || isFailed;
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const metadataOf = ({ uaFullVersion, ...hints }: Hints): UserAgentMetadata => ({
  ...hints,
  fullVersion: uaFullVersion,
});

const presentedUserAgentOf = (text: string): PresentedUserAgent | undefined => {
  const reading: unknown = JSON.parse(text);

  if (!isReading(reading)) {
    throw new Error("The browser reported a malformed user agent.");
  }

  return reading.userAgent.includes(HEADLESS_TOKEN)
    ? {
        metadata: metadataOf(reading.hints),
        userAgent: reading.userAgent.replaceAll(HEADLESS_TOKEN, HEADED_TOKEN),
      }
    : undefined;
};

const retireProbe = async (
  browser: DriverBrowser | undefined,
  scratch: ScratchDir,
  groups: ReadonlySet<number>,
  cleanups: readonly Promise<void>[],
): Promise<void> => {
  const signal = AbortSignal.timeout(TEARDOWN_BUDGET_MS);

  try {
    await settleWithin(Promise.allSettled(cleanups), CLEANUP_BUDGET_MS);
    await settleWithin(browser?.close(CLOSE_BUDGET_MS) ?? Promise.resolve(), CLOSE_BUDGET_MS);

    const exited = await Promise.all(
      [...groups].map(async (pid) => await retireProcessGroup(pid, signal)),
    );

    if (exited.includes(false)) {
      throw new Error("Chrome outlived its user agent probe, so its scratch was kept.");
    }

    await removeScratchDir(scratch, signal);
  } catch (error) {
    publishInternalEvent({
      detail: `Removing the user agent probe's scratch failed: ${messageOf(error)}`,
      event: "teardown-incomplete",
    });
  }
};

const readFromBrowser = async (
  binary: string,
  { budgetMs, driver, now, scratchRoot, signal }: HeadlessUserAgentOptions,
): Promise<PresentedUserAgent | undefined> => {
  const scratch = await createScratchDir(now(), scratchRoot, "probe");
  const groups = new Set<number>();
  const cleanups: Promise<void>[] = [];
  let browser: DriverBrowser | undefined;

  try {
    using deadline = startDeadline(budgetMs, signal);
    const { page, plan } = planHeadlessProbe(binary, scratch.path);

    await prepareProfile(plan);

    browser = await driver.launch(
      plan,
      deadline,
      (pid) => {
        groups.add(pid);
      },
      (cleanup) => {
        cleanups.push(cleanup);
      },
    );

    await browser.navigate(page, deadline);

    return presentedUserAgentOf(await browser.evaluateIsolated(USER_AGENT_READ, isText, deadline));
  } finally {
    await retireProbe(browser, scratch, groups, cleanups);
  }
};

const keyOf = async (binary: string): Promise<string> =>
  createHash("sha256")
    .update(JSON.stringify([await fileIdentityOf(binary), release()]))
    .digest("hex");

const readStored = async (file: string): Promise<StoredUserAgent | undefined> => {
  let stored: unknown;

  try {
    stored = JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return undefined;
  }

  return isStoredUserAgent(stored) ? stored : undefined;
};

const store = async (file: string, stored: StoredUserAgent): Promise<void> => {
  await Promise.allSettled([writeAtomically(file, JSON.stringify(stored))]);
};

const eventDetailOf = (binary: string, learning: Learning): string =>
  JSON.stringify(
    "reason" in learning
      ? { binary, reason: learning.reason, userAgent: null }
      : { binary, userAgent: learning.presented?.userAgent ?? null },
  );

export const createHeadlessUserAgentReader = (
  options: HeadlessUserAgentOptions,
): HeadlessUserAgentReader => {
  const entries = new Map<string, UserAgentEntry>();

  const isFresh = (at: number, ttlMs: number): boolean => options.now() - at < ttlMs;

  const knownFrom = (stored: StoredUserAgent | undefined): Learned | undefined => {
    if (stored?.kind === "learned" && isFresh(stored.learnedAt, LEARNED_TTL_MS)) {
      return {
        expiresAt: stored.learnedAt + LEARNED_TTL_MS,
        presented: stored.presented ?? undefined,
      };
    }

    return stored?.kind === "failed" && isFresh(stored.failedAt, FAILED_TTL_MS)
      ? { expiresAt: stored.failedAt + FAILED_TTL_MS, presented: undefined }
      : undefined;
  };

  const learning = async (binary: string): Promise<Learning> => {
    try {
      return { presented: await readFromBrowser(binary, options) };
    } catch (error) {
      return { reason: messageOf(error) };
    }
  };

  const learn = async (binary: string, file: string): Promise<Learned> => {
    const known = knownFrom(await readStored(file));

    if (known !== undefined) {
      return known;
    }

    const learned = await learning(binary);

    publishInternalEvent({
      detail: eventDetailOf(binary, learned),
      event: "headless-user-agent-probed",
    });

    if ("reason" in learned) {
      const failedAt = options.now();

      if (!options.signal.aborted) {
        await store(file, {
          failedAt,
          format: USER_AGENT_FORMAT,
          kind: "failed",
          reason: learned.reason,
        });
      }

      return { expiresAt: failedAt + FAILED_TTL_MS, presented: undefined };
    }

    const learnedAt = options.now();

    await store(file, {
      format: USER_AGENT_FORMAT,
      kind: "learned",
      learnedAt,
      presented: learned.presented ?? null,
    });

    return { expiresAt: learnedAt + LEARNED_TTL_MS, presented: learned.presented };
  };

  return async (binary) => {
    const key = await keyOf(binary);
    const known = entries.get(key);

    if (known !== undefined && (known.expiresAt === undefined || options.now() < known.expiresAt)) {
      const { presented } = await known.learned;

      return presented;
    }

    const entry: UserAgentEntry = {
      learned: learn(binary, path.join(options.root, `headless-user-agent-${key}.json`)),
    };

    entries.set(key, entry);

    const { expiresAt, presented } = await entry.learned;

    entry.expiresAt = expiresAt;

    return presented;
  };
};
