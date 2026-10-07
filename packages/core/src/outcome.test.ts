import { describe, expect, it } from "vite-plus/test";

import { startDeadline, untilDeadline } from "./deadline.ts";
import { XrioError } from "./errors.ts";
import { scrapeError } from "./outcome.ts";
import { manualClock } from "./testing/manual-clock.ts";

const genericFailure = new Error("The runtime failed.");

describe(scrapeError, () => {
  it("preserves an early classified error after expiration, including a wrapper", async () => {
    let now = 0;
    const clock = { now: () => now, setTimer: () => () => {} };
    using deadline = startDeadline(1000, undefined, clock);
    const failure = new XrioError("NETWORK_ERROR", "The peer refused.", { details: undefined });

    const result = untilDeadline(async () => {
      now = 1000;

      return await Promise.reject(failure);
    }, deadline);

    await expect(result).rejects.toBe(failure);
    expect(() => {
      deadline.throwIfExpired();
    }).toThrow(expect.objectContaining({ code: "TIMEOUT" }));
    expect(scrapeError(failure, deadline)).toBe(failure);
  });

  it("keeps the caller's winning reason after later expiration", () => {
    const { advance, clock } = manualClock();
    const caller = new AbortController();
    using deadline = startDeadline(1000, caller.signal, clock);
    const reason = new Error("The caller stopped.");

    caller.abort(reason);
    advance(1000);

    expect(deadline.abortReason()).toBe("caller");
    expect(scrapeError(genericFailure, deadline)).toBe(reason);
  });

  it("keeps ownership as the winner after a later caller abort", () => {
    const { clock } = manualClock();
    const caller = new AbortController();
    const owner = new AbortController();
    using deadline = startDeadline(1000, caller.signal, clock);
    const held = deadline.boundTo(owner.signal, "ownership");

    owner.abort(new Error("Ownership expired."));
    caller.abort(new Error("The caller stopped."));

    expect(held.abortReason()).toBe("ownership");
    expect(scrapeError(genericFailure, held)).toMatchObject({
      code: "SESSION_UNAVAILABLE",
      details: { reason: "ownership-lost" },
    });
  });

  it("wraps a non-Error caller reason with its original cause", () => {
    using deadline = startDeadline(1000, AbortSignal.abort("stop"));

    expect(scrapeError(genericFailure, deadline)).toMatchObject({
      cause: "stop",
      name: "AbortError",
    });
  });

  it("keeps un-aborted errors and maps only actual expiry to TIMEOUT", () => {
    const { advance, clock } = manualClock();
    using deadline = startDeadline(1000, undefined, clock);

    expect(scrapeError(genericFailure, deadline)).toBe(genericFailure);
    advance(1000);
    expect(scrapeError(genericFailure, deadline)).toMatchObject({ code: "TIMEOUT" });
  });
});
