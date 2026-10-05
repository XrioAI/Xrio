import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { resolveClientOptions, resolveScrapeIntent } from "../options.ts";
import {
  anonymousSessions,
  claimSession,
  finishVisit,
  HoldRefusedError,
  ownershipSchedule,
  profileAfterVisit,
  releaseSession,
  renewOwnership,
} from "./session.ts";
import type { SessionContext } from "./session.ts";

const named: Extract<SessionContext, { kind: "named" }> = {
  id: "shop-1",
  kind: "named",
  ownership: { epoch: 1, expiresAt: 60_000, signal: new AbortController().signal },
  pins: { display: undefined, locale: undefined, timezone: "Europe/Berlin" },
  record: {
    device: {
      cores: 8,
      fonts: { kind: "system" },
      gpu: { backend: "native" },
      memoryGb: 8,
      screen: { height: 1080, width: 1920, workArea: { bottom: 48, left: 0, right: 0, top: 0 } },
      voices: { kind: "system" },
      window: { kind: "maximized" },
    },
    policy: { locale: "en-US", timezone: { kind: "pinned", zone: "Europe/Berlin" } },
    schema: 1,
    seed: "9f2c41d07a3be815",
  },
};

const browser = resolveScrapeIntent(
  { format: "html", url: "https://example.com" },
  resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
);

describe(anonymousSessions, () => {
  it("draws a fresh device and holds ownership until it is released", async () => {
    using deadline = startDeadline(1000);

    const hold = await anonymousSessions().hold(
      browser.session,
      { identity: browser.identity, seed: () => "9f2c41d07a3be815", source: browser.source },
      deadline,
    );

    const held = hold.bind(deadline);

    expect(hold.device).toStrictEqual({ kind: "fresh", seed: "9f2c41d07a3be815" });
    expect(held.signal.aborted).toBeFalsy();
    await hold[Symbol.asyncDispose]();
    await hold[Symbol.asyncDispose]();
    expect([held.signal.aborted, held.abortReason(), deadline.signal.aborted]).toStrictEqual([
      true,
      "ownership",
      false,
    ]);
  });
});

describe("session operations", () => {
  it.each([
    {
      operation: "claimSession",
      run: async () => {
        await claimSession({ holdMs: 60_000, id: "shop-1" });
      },
    },
    {
      operation: "renewOwnership",
      run: async () => {
        await renewOwnership(named);
      },
    },
    {
      operation: "finishVisit",
      run: async () => {
        await finishVisit(named, { exited: true });
      },
    },
    {
      operation: "releaseSession",
      run: async () => {
        await releaseSession(named);
      },
    },
  ])("$operation throws until the session manager exists", async ({ operation, run }) => {
    await expect(run()).rejects.toThrow(
      `${operation} is not implemented until the session manager exists.`,
    );
  });
});

const scheduleOrRefusal = (claimedAt: number, expiresAt: number) => {
  try {
    return { schedule: ownershipSchedule(claimedAt, { expiresAt }) };
  } catch (error) {
    return error instanceof HoldRefusedError
      ? { message: error.message, refusal: error.refusal }
      : { error };
  }
};

describe(ownershipSchedule, () => {
  it.each([
    {
      claimedAt: 0,
      expiresAt: 60_000,
      schedule: { abortAt: 50_000, claimableAt: 65_000, renewAt: 20_000 },
    },
    {
      claimedAt: 0,
      expiresAt: 30_000,
      schedule: { abortAt: 20_000, claimableAt: 35_000, renewAt: 10_000 },
    },
    {
      claimedAt: 1_000_000,
      expiresAt: 1_060_000,
      schedule: { abortAt: 1_050_000, claimableAt: 1_065_000, renewAt: 1_020_000 },
    },
    {
      claimedAt: 9_007_199_254_000_000,
      expiresAt: 9_007_199_254_030_000,
      schedule: {
        abortAt: 9_007_199_254_020_000,
        claimableAt: 9_007_199_254_035_000,
        renewAt: 9_007_199_254_010_000,
      },
    },
    {
      claimedAt: 1_000_000,
      expiresAt: 1_090_000,
      schedule: { abortAt: 1_080_000, claimableAt: 1_095_000, renewAt: 1_030_000 },
    },
  ])(
    "renews a third into a hold from $claimedAt to $expiresAt, aborts 10 s before expiry, and allows a claim 5 s after",
    ({ claimedAt, expiresAt, schedule }) => {
      expect(ownershipSchedule(claimedAt, { expiresAt })).toStrictEqual(schedule);
    },
  );

  it("orders renewal, local abort, expiry and the next claim for every accepted hold", () => {
    const holds = [30_000, 31_000, 45_000, 60_000, 300_000, 3_600_000];

    const ordered = holds.map((expiresAt) => {
      const { abortAt, claimableAt, renewAt } = ownershipSchedule(0, { expiresAt });

      return renewAt < abortAt && abortAt < expiresAt && expiresAt < claimableAt;
    });

    expect(ordered).toStrictEqual(holds.map(() => true));
  });

  it.each([
    {
      claimedAt: 0,
      expiresAt: 12_000,
      message: "An ownership hold of 12000 ms is shorter than the 30000 ms minimum.",
      refusal: { holdMs: 12_000, kind: "too-short" },
    },
    {
      claimedAt: 0,
      expiresAt: 29_999,
      message: "An ownership hold of 29999 ms is shorter than the 30000 ms minimum.",
      refusal: { holdMs: 29_999, kind: "too-short" },
    },
    {
      claimedAt: 1_000_000,
      expiresAt: 1_020_000,
      message: "An ownership hold of 20000 ms is shorter than the 30000 ms minimum.",
      refusal: { holdMs: 20_000, kind: "too-short" },
    },
    {
      claimedAt: 0,
      expiresAt: Number.NaN,
      message: "Ownership expiresAt must be a safe integer of milliseconds.",
      refusal: { field: "expiresAt", kind: "not-safe-integer" },
    },
    {
      claimedAt: 0,
      expiresAt: Number.POSITIVE_INFINITY,
      message: "Ownership expiresAt must be a safe integer of milliseconds.",
      refusal: { field: "expiresAt", kind: "not-safe-integer" },
    },
    {
      claimedAt: -1e308,
      expiresAt: 1.7e308,
      message: "Ownership claimedAt must be a safe integer of milliseconds.",
      refusal: { field: "claimedAt", kind: "not-safe-integer" },
    },
    {
      claimedAt: 1e20,
      expiresAt: 1e20 + 30_000,
      message: "Ownership claimedAt must be a safe integer of milliseconds.",
      refusal: { field: "claimedAt", kind: "not-safe-integer" },
    },
    {
      claimedAt: 0,
      expiresAt: 60_000.5,
      message: "Ownership expiresAt must be a safe integer of milliseconds.",
      refusal: { field: "expiresAt", kind: "not-safe-integer" },
    },
    {
      claimedAt: 0.5,
      expiresAt: 60_000,
      message: "Ownership claimedAt must be a safe integer of milliseconds.",
      refusal: { field: "claimedAt", kind: "not-safe-integer" },
    },
    {
      claimedAt: Number.NaN,
      expiresAt: 60_000,
      message: "Ownership claimedAt must be a safe integer of milliseconds.",
      refusal: { field: "claimedAt", kind: "not-safe-integer" },
    },
    {
      claimedAt: Number.NEGATIVE_INFINITY,
      expiresAt: 60_000,
      message: "Ownership claimedAt must be a safe integer of milliseconds.",
      refusal: { field: "claimedAt", kind: "not-safe-integer" },
    },
  ])(
    "refuses a hold claimed at $claimedAt that expires at $expiresAt",
    ({ claimedAt, expiresAt, message, refusal }) => {
      expect(scheduleOrRefusal(claimedAt, expiresAt)).toStrictEqual({ message, refusal });
    },
  );
});

describe(profileAfterVisit, () => {
  it("frees a profile only when Chrome exited", () => {
    expect(profileAfterVisit({ exited: true })).toStrictEqual({ state: "reusable" });
    expect(
      profileAfterVisit({ exited: false, reason: "Chrome outlived its teardown." }),
    ).toStrictEqual({
      reason:
        "Quarantined until the startup sweep finds no process holding it: Chrome outlived its teardown.",
      state: "quarantined",
    });
  });
});
