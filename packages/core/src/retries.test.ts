import { describe, expect, it } from "vite-plus/test";

import type { BlockReport, BlockVerdict } from "./blocks/classify.ts";
import { startDeadline } from "./deadline.ts";
import { invalidOptions, XrioError } from "./errors.ts";
import { parseProxy } from "./options.ts";
import { createRetries } from "./retries.ts";
import { manualClock } from "./testing/manual-clock.ts";
import type { ProxyEndpoint } from "./types.ts";

const failure = new XrioError("NETWORK_ERROR", "Connection failed.", { details: undefined });

const sameExit = { freshExitAfter: (): undefined => undefined };

const blockedRoute = parseProxy("http://user-11111111:secret@proxy.test");

const freshRoute = parseProxy("http://user-22222222:secret@proxy.test");

const reading = (verdict: BlockVerdict): BlockReport => ({
  challenge: null,
  evidence: [],
  passedChallenges: [],
  vendor: verdict === "blocked" ? "cloudflare" : null,
  verdict,
});

const exitsOffering = (fresh?: ProxyEndpoint) => {
  const asked: (ProxyEndpoint | undefined)[] = [];

  return {
    asked,
    freshExitAfter: (blocked: ProxyEndpoint | undefined) => {
      asked.push(blocked);

      return fresh;
    },
  };
};

describe(createRetries, () => {
  it("samples exponential full jitter, caps it, and consumes the configured retry count", () => {
    using deadline = startDeadline(100_000);
    const retries = createRetries(8, deadline, () => 0.5, sameExit);

    expect(Array.from({ length: 9 }, () => retries.next(failure))).toStrictEqual([
      500,
      1000,
      2000,
      4000,
      8000,
      15_000,
      15_000,
      15_000,
      undefined,
    ]);
  });

  it.each([
    new XrioError("NETWORK_ERROR", "Failed.", { details: undefined }),
    new XrioError("PROXY_UNREACHABLE", "Failed.", { details: undefined }),
    new XrioError("PROXY_CONNECT_FAILED", "Failed.", { details: { status: 502 } }),
    new XrioError("BROWSER_CRASHED", "Failed.", { details: undefined }),
  ])("retries $code", (candidate: Error) => {
    using deadline = startDeadline(5000);
    const retries = createRetries(1, deadline, () => 0.5, sameExit);

    expect(retries.next(candidate)).toBe(500);
  });

  it.each([
    new XrioError("TIMEOUT", "Failed.", { details: undefined }),
    new XrioError("PROXY_AUTH_FAILED", "Failed.", { details: undefined }),
    new XrioError("PROXY_INFO_UNAVAILABLE", "Failed.", { details: undefined }),
    new XrioError("BROWSER_LAUNCH_FAILED", "Failed.", { details: { mismatches: [], stderr: "" } }),
    new XrioError("RESPONSE_TOO_LARGE", "Failed.", { details: undefined }),
    new XrioError("TLS_CERTIFICATE_INVALID", "Failed.", { details: undefined }),
    new XrioError("TOO_MANY_REDIRECTS", "Failed.", { details: undefined }),
    new XrioError("CLIENT_CLOSED", "Failed.", { details: undefined }),
    invalidOptions("Failed."),
  ])("does not retry $code", (candidate: Error) => {
    using deadline = startDeadline(5000);
    const retries = createRetries(1, deadline, () => 0.5, sameExit);

    expect(retries.next(candidate)).toBeUndefined();
    expect(retries.next(failure)).toBe(500);
  });

  it("does not retry unclassified errors", () => {
    using deadline = startDeadline(5000);

    expect(
      createRetries(1, deadline, () => 0.5, sameExit).next(new Error("Failed.")),
    ).toBeUndefined();
  });

  it("skips backoff when only the minimum attempt fits and refuses a shorter attempt", async () => {
    const { advance, clock, pendingTimers } = manualClock();
    using deadline = startDeadline(1001, undefined, clock);
    const retries = createRetries(2, deadline, () => 0.5, sameExit);

    expect(retries.next(failure)).toBe(0);
    await expect(retries.wait(500)).resolves.toBeTruthy();
    expect(pendingTimers()).toBe(1);
    advance(2);
    expect(retries.next(failure)).toBeUndefined();
    await expect(retries.wait(0)).resolves.toBeFalsy();
  });

  it("uses the original clock and cancels its backoff timer on abort", async () => {
    const { advance, clock, pendingTimers } = manualClock();
    const caller = new AbortController();
    using deadline = startDeadline(5000, caller.signal, clock);
    const retries = createRetries(1, deadline, () => 0.5, sameExit);
    const waiting = retries.wait(500);

    advance(499);
    expect(pendingTimers()).toBe(2);
    const aborted = new Error("Caller stopped.");
    caller.abort(aborted);
    await expect(waiting).rejects.toBe(aborted);
    expect(pendingTimers()).toBe(1);
    expect(retries.next(failure)).toBeUndefined();
  });

  it("moves a blocked page to a fresh exit without backoff and spends one retry on it", () => {
    using deadline = startDeadline(5000);
    const exits = exitsOffering(freshRoute);
    const retries = createRetries(1, deadline, () => 0.5, exits);

    expect({
      afterBlock: retries.freshExitAfter(reading("blocked"), blockedRoute),
      afterFailure: retries.next(failure),
      asked: exits.asked,
    }).toStrictEqual({ afterBlock: freshRoute, afterFailure: undefined, asked: [blockedRoute] });
  });

  it.each(["ok", "suspect", "queued", "unknown"] as const)(
    "keeps a page that reads %s without asking for a fresh exit",
    (verdict) => {
      using deadline = startDeadline(5000);
      const exits = exitsOffering(freshRoute);
      const retries = createRetries(1, deadline, () => 0.5, exits);

      expect(retries.freshExitAfter(reading(verdict), blockedRoute)).toBeUndefined();
      expect(exits.asked).toStrictEqual([]);
      expect(retries.next(failure)).toBe(500);
    },
  );

  it("keeps a blocked page and its retry when the route cannot change", () => {
    using deadline = startDeadline(5000);
    const exits = exitsOffering();
    const retries = createRetries(1, deadline, () => 0.5, exits);

    expect(retries.freshExitAfter(reading("blocked"), blockedRoute)).toBeUndefined();
    expect(exits.asked).toStrictEqual([blockedRoute]);
    expect(retries.next(failure)).toBe(500);
  });

  it.each([
    { elapsedMs: 0, retries: 0 },
    { elapsedMs: 4001, retries: 1 },
  ])(
    "keeps a blocked page without rotating when $retries retries remain after $elapsedMs ms",
    ({ elapsedMs, retries: count }) => {
      const { advance, clock } = manualClock();
      using deadline = startDeadline(5000, undefined, clock);
      const exits = exitsOffering(freshRoute);
      const retries = createRetries(count, deadline, () => 0.5, exits);

      advance(elapsedMs);

      expect(retries.freshExitAfter(reading("blocked"), blockedRoute)).toBeUndefined();
      expect(exits.asked).toStrictEqual([]);
    },
  );
});
