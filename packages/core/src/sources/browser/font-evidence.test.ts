import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import type { FontEvidence, HostCapabilities } from "../../humanizer/contracts.ts";
import type { FontEvidenceOutcome } from "../../humanizer/verify.ts";
import { CHECKED_FONT_STACK } from "../../testing/fake-font-stack.ts";
import { createFontEvidenceStore } from "./font-evidence.ts";
import type { FontClaim } from "./font-evidence.ts";

const HOUR_MS = 60 * 60 * 1000;

const DAY_MS = 24 * HOUR_MS;

const UNPROVEN_TTL_MS = 60_000;

const GATHERED: FontEvidenceOutcome = {
  digest: "384a83ee",
  kind: "gathered",
  sentinel: "c6755abb",
};

const WITH_STACK: HostCapabilities = { fontStack: CHECKED_FONT_STACK, platform: "linux" };

type StoreOverrides = Parameters<typeof createFontEvidenceStore>[0];

const clockAt = (start: number) => {
  let now = start;

  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
};

const useEvidenceHarness = () => {
  let root = "";
  let binary = "";
  let started: Deadline & Disposable;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-font-evidence-"));
    binary = path.join(root, "chrome");
    await writeFile(binary, "#!/bin/sh\n");
    started = startDeadline(20_000);
  });

  afterEach(async () => {
    started[Symbol.dispose]();
    await rm(root, { force: true, recursive: true });
  });

  const scratch = () => path.join(root, "scratch");

  const storeWith = (overrides: StoreOverrides = {}) =>
    createFontEvidenceStore({ root: scratch(), ...overrides });

  const claimOn = async (
    store = storeWith(),
    capabilities = WITH_STACK,
    locale = "en-US",
  ): Promise<FontClaim> => await store.claim(binary, capabilities, locale, started);

  const evidenceOn = async (
    store = storeWith(),
    capabilities = WITH_STACK,
    locale = "en-US",
  ): Promise<FontEvidence | undefined> => {
    const { evidence } = await claimOn(store, capabilities, locale);

    return evidence;
  };

  const settleOn = async (outcome: FontEvidenceOutcome | null, store = storeWith()) => {
    const claim = await claimOn(store);

    await claim.settle(outcome);
  };

  const files = async (): Promise<string[]> => {
    try {
      const names = await readdir(scratch());

      return names.filter((name) => name.startsWith("font-evidence-"));
    } catch {
      return [];
    }
  };

  return {
    binary: () => binary,
    claimOn,
    deadline: () => started,
    evidenceOn,
    files,
    root: () => root,
    scratch,
    settleOn,
    storeWith,
  };
};

describe("the fonts evidence store, recording and reading", () => {
  const { claimOn, evidenceOn, files, scratch, settleOn, storeWith } = useEvidenceHarness();

  it("gives the first claim on a host nothing, and records what it gathers once it settles", async () => {
    const claim = await claimOn();

    expect(claim.evidence).toBeUndefined();
    await claim.settle(GATHERED);

    const [file = ""] = await files();
    const stored: unknown = JSON.parse(await readFile(path.join(scratch(), file), "utf-8"));

    expect(file).toMatch(/^font-evidence-[\da-f]{64}\.json$/u);
    expect(stored).toMatchObject({ digest: "384a83ee", format: 1, sentinel: "c6755abb" });
  });

  it("gives every later claim, in any process, the stored evidence with its key and age", async () => {
    const clock = clockAt(1_000_000);

    await settleOn(GATHERED, storeWith({ now: clock.now }));
    clock.advance(90 * 60 * 1000);

    const evidence = await evidenceOn(storeWith({ now: clock.now }));

    expect({ ...evidence, key: evidence?.key.length }).toStrictEqual({
      ageMs: 5_400_000,
      digest: "384a83ee",
      key: 64,
      sentinel: "c6755abb",
    });
  });

  it("records nothing from a gathering launch whose stack was not proven", async () => {
    await settleOn({ kind: "unproven" });

    await expect(files()).resolves.toStrictEqual([]);
    await expect(evidenceOn(storeWith())).resolves.toBeUndefined();
  });

  it("records nothing from a launch that failed, and lets the next claim gather", async () => {
    const store = storeWith();

    await settleOn(null, store);

    await expect(files()).resolves.toStrictEqual([]);
    await expect(evidenceOn(store)).resolves.toBeUndefined();
  });

  it("expires the evidence after 24 h", async () => {
    const clock = clockAt(1_000_000);
    const store = storeWith({ now: clock.now });

    await settleOn(GATHERED, store);
    clock.advance(DAY_MS - 1);

    const fresh = await evidenceOn(store);

    clock.advance(1);

    expect(fresh?.ageMs).toBe(DAY_MS - 1);
    await expect(evidenceOn(storeWith({ now: clock.now }))).resolves.toBeUndefined();
  });

  it("ignores a stored file it cannot read, and settles twice as once", async () => {
    await settleOn(GATHERED);

    const [file = ""] = await files();

    await writeFile(path.join(scratch(), file), "{ not json");

    const regathering = await claimOn(storeWith());

    await regathering.settle(GATHERED);
    await regathering.settle(null);

    const afterwards = await evidenceOn(storeWith());

    expect(regathering.evidence).toBeUndefined();
    expect(afterwards?.digest).toBe("384a83ee");
  });

  it("never fails a settle whose evidence cannot be written", async () => {
    await writeFile(scratch(), "a file where the scratch root should be");

    const claim = await claimOn();

    await expect(claim.settle(GATHERED)).resolves.toBeUndefined();
  });
});

describe("the fonts evidence store, keys", () => {
  const { binary, claimOn, deadline, evidenceOn, files, scratch, settleOn, storeWith } =
    useEvidenceHarness();

  it.each([
    {
      capabilities: {
        fontStack: { ...CHECKED_FONT_STACK, payload: "0".repeat(64) },
        platform: "linux" as const,
      },
      change: "a stack with another payload",
    },
    {
      capabilities: { platform: "linux" as const },
      change: "the host fonts instead of a checked stack",
    },
    {
      capabilities: { fontStack: CHECKED_FONT_STACK, platform: "darwin" as const },
      change: "another platform",
    },
  ])("gathers again for $change", async ({ capabilities }) => {
    const store = storeWith();

    await settleOn(GATHERED, store);

    await expect(evidenceOn(store, capabilities)).resolves.toBeUndefined();
  });

  it("gathers again for another presented locale, and keeps one entry per locale", async () => {
    const store = storeWith();

    await settleOn(GATHERED, store);

    const german = await claimOn(store, WITH_STACK, "de-DE");

    await german.settle({ ...GATHERED, digest: "5f5f5f5f" });

    const [english, translated] = await Promise.all([
      evidenceOn(store),
      evidenceOn(store, WITH_STACK, "de-DE"),
    ]);

    expect([english?.digest, translated?.digest]).toStrictEqual(["384a83ee", "5f5f5f5f"]);
    await expect(files()).resolves.toHaveLength(2);
  });

  it("gathers again once the binary changes", async () => {
    const later = new Date(Date.now() + HOUR_MS);

    await settleOn(GATHERED);
    await utimes(binary(), later, later);

    await expect(evidenceOn(storeWith())).resolves.toBeUndefined();
  });

  it("gives a binary it cannot find no claim, and never fails", async () => {
    const claim = await storeWith().claim(
      path.join(scratch(), "missing"),
      WITH_STACK,
      "en-US",
      deadline(),
    );

    await claim.settle(GATHERED);

    expect(claim.evidence).toBeUndefined();
    await expect(files()).resolves.toStrictEqual([]);
  });
});

describe("the fonts evidence store, concurrent launches", () => {
  const { claimOn, evidenceOn, files, storeWith } = useEvidenceHarness();

  it("stops queuing claims for 60 s once a gatherer reports an unproven stack, and never stores it", async () => {
    const clock = clockAt(1_000_000);
    const store = storeWith({ now: clock.now });
    const first = await claimOn(store);
    const waiting = claimOn(store);

    await first.settle({ kind: "unproven" });

    const claims = await Promise.all([waiting, claimOn(store), claimOn(store), claimOn(store)]);

    expect(claims.map(({ evidence }) => evidence)).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    await expect(files()).resolves.toStrictEqual([]);

    clock.advance(UNPROVEN_TTL_MS - 1);

    const quiet = await claimOn(store);

    clock.advance(1);

    const owner = await claimOn(store);
    const queued = claimOn(store);
    const early = await Promise.race([queued.then(() => "claimed"), delay(50, "waiting")]);

    await owner.settle(GATHERED);
    await queued;
    expect([quiet.evidence, early]).toStrictEqual([undefined, "waiting"]);
  });

  it("shares one gatherer among concurrent claims, which then get its evidence", async () => {
    const store = storeWith();
    const first = await claimOn(store);
    const waiting = [evidenceOn(store), evidenceOn(store)];

    await first.settle(GATHERED);

    const evidence = await Promise.all(waiting);

    expect(evidence.map((found) => found?.digest)).toStrictEqual(["384a83ee", "384a83ee"]);
    await expect(files()).resolves.toHaveLength(1);
  });

  it("lets one waiter gather when the gatherer fails, and the other wait for it", async () => {
    const store = storeWith();
    const first = await claimOn(store);
    const waiting = [claimOn(store), claimOn(store)];

    await first.settle(null);

    const gatherer = await Promise.race(waiting);

    await gatherer.settle(GATHERED);

    const claims = await Promise.all(waiting);

    expect(
      claims
        .map(({ evidence }) => evidence?.digest ?? "none")
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(["384a83ee", "none"]);
  });

  it("stops waiting for a gatherer that never settles, and gathers without owning the key", async () => {
    const store = storeWith({ gathererWaitMs: 50 });

    await claimOn(store);

    const stranded = await claimOn(store);

    await stranded.settle(GATHERED);

    expect(stranded.evidence).toBeUndefined();
    await expect(files()).resolves.toHaveLength(1);
  });

  it("stops waiting when its client closes", async () => {
    const closing = new AbortController();
    const store = storeWith({ gathererWaitMs: 60_000, signal: closing.signal });

    await claimOn(store);

    const waiting = evidenceOn(store);

    closing.abort();

    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("the fonts evidence store, a launch's verdict on stored evidence", () => {
  const { evidenceOn, files, settleOn, storeWith } = useEvidenceHarness();

  it("drops the evidence when a launch reports a drifted sentinel, so the next claim gathers", async () => {
    const store = storeWith();

    await settleOn(GATHERED, store);
    await settleOn({ kind: "drifted" }, store);

    await expect(files()).resolves.toStrictEqual([]);
    await expect(evidenceOn(storeWith())).resolves.toBeUndefined();
  });

  it("keeps the evidence when a launch confirms its sentinel", async () => {
    const store = storeWith();

    await settleOn(GATHERED, store);
    await settleOn({ kind: "confirmed" }, store);

    const kept = await evidenceOn(store);

    expect(kept?.digest).toBe("384a83ee");
  });
});
