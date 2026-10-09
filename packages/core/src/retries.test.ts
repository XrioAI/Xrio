import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "./deadline.ts";
import { invalidOptions, XrioError } from "./errors.ts";
import { createRetries } from "./retries.ts";
import { manualClock } from "./testing/manual-clock.ts";

const failure = new XrioError("NETWORK_ERROR", "Connection failed.", { details: undefined });

describe(createRetries, () => {
  it("samples exponential full jitter, caps it, and consumes the configured retry count", () => {
    using deadline = startDeadline(100_000);
    const retries = createRetries(8, deadline, () => 0.5);

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
    const retries = createRetries(1, deadline, () => 0.5);

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
    const retries = createRetries(1, deadline, () => 0.5);

    expect(retries.next(candidate)).toBeUndefined();
    expect(retries.next(failure)).toBe(500);
  });

  it("does not retry unclassified errors", () => {
    using deadline = startDeadline(5000);

    expect(createRetries(1, deadline, () => 0.5).next(new Error("Failed."))).toBeUndefined();
  });

  it("skips backoff when only the minimum attempt fits and refuses a shorter attempt", async () => {
    const { advance, clock, pendingTimers } = manualClock();
    using deadline = startDeadline(1001, undefined, clock);
    const retries = createRetries(2, deadline, () => 0.5);

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
    const retries = createRetries(1, deadline, () => 0.5);
    const waiting = retries.wait(500);

    advance(499);
    expect(pendingTimers()).toBe(2);
    const aborted = new Error("Caller stopped.");
    caller.abort(aborted);
    await expect(waiting).rejects.toBe(aborted);
    expect(pendingTimers()).toBe(1);
    expect(retries.next(failure)).toBeUndefined();
  });
});
