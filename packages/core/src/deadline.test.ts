import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "./deadline.ts";
import { manualClock } from "./testing/manual-clock.ts";

describe(startDeadline, () => {
  it.each([
    { elapsedMs: 0, remainingMs: 1000, stageTimeoutMs: 250 },
    { elapsedMs: 900, remainingMs: 100, stageTimeoutMs: 100 },
    { elapsedMs: 999.5, remainingMs: 1, stageTimeoutMs: 1 },
  ])(
    "after $elapsedMs ms, $remainingMs ms remain and a 250 ms stage gets $stageTimeoutMs ms",
    ({ elapsedMs, remainingMs, stageTimeoutMs }) => {
      const { advance, clock } = manualClock();
      const deadline = startDeadline(1000, undefined, clock);

      advance(elapsedMs);

      expect(deadline.remainingMs()).toBe(remainingMs);
      expect(deadline.stageTimeout(250)).toBe(stageTimeoutMs);
    },
  );

  it("refuses to start a stage once the clock has passed the deadline, before its timer fires", () => {
    let now = 0;
    const clock = { now: () => now, setTimer: () => () => {} };
    const deadline = startDeadline(1000, undefined, clock);

    now = 1000;

    expect(() => deadline.startStage(250)).toThrow(expect.objectContaining({ code: "TIMEOUT" }));
    expect(() => deadline.stageTimeout(250)).toThrow(expect.objectContaining({ code: "TIMEOUT" }));
    expect(deadline.signal.reason).toMatchObject({ code: "TIMEOUT" });
  });

  it("aborts with TIMEOUT when the deadline passes", () => {
    const { advance, clock } = manualClock();
    const deadline = startDeadline(1000, undefined, clock);

    advance(999);
    expect(deadline.signal.aborted).toBeFalsy();

    advance(1);
    expect(deadline.signal.aborted).toBeTruthy();
    expect(deadline.signal.reason).toMatchObject({ code: "TIMEOUT", name: "XrioError" });
  });

  it("aborts with the caller's reason when the caller aborts first", () => {
    const { advance, clock } = manualClock();
    const controller = new AbortController();
    const reason = new Error("Stopped by caller");
    const deadline = startDeadline(1000, controller.signal, clock);

    controller.abort(reason);
    advance(1000);

    expect(deadline.signal.reason).toBe(reason);
    expect(startDeadline(1000, AbortSignal.abort(reason), clock).signal.reason).toBe(reason);
  });

  it("cancels its timer when disposed", () => {
    const { clock, pendingTimers } = manualClock();

    {
      using _deadline = startDeadline(1000, undefined, clock);
      expect(pendingTimers()).toBe(1);
    }

    expect(pendingTimers()).toBe(0);
  });
});

describe("deadline stages", () => {
  it("aborts a stage with its own error when its cap elapses first", () => {
    const { advance, clock } = manualClock();
    const deadline = startDeadline(1000, undefined, clock);
    using stage = deadline.startStage(250);

    advance(250);

    expect(stage.signal.reason).toMatchObject({
      message: "The stage did not finish within 250 ms.",
    });
    expect(deadline.signal.aborted).toBeFalsy();
  });

  it("fires a stage's cap before the deadline when time jumps past both", () => {
    const { advance, clock } = manualClock();
    const deadline = startDeadline(1000, undefined, clock);
    using stage = deadline.startStage(250);

    advance(1000);

    expect(stage.signal.reason).toMatchObject({
      message: "The stage did not finish within 250 ms.",
    });
    expect(deadline.signal.reason).toMatchObject({ code: "TIMEOUT" });
  });

  it("aborts a stage with TIMEOUT when the deadline caps it", () => {
    const { advance, clock } = manualClock();
    const deadline = startDeadline(1000, undefined, clock);
    using stage = deadline.startStage(5000);

    advance(1000);

    expect(stage.signal.reason).toMatchObject({ code: "TIMEOUT" });
  });

  it("aborts a stage with the caller's reason", () => {
    const { clock } = manualClock();
    const controller = new AbortController();
    const reason = new Error("Stopped by caller");
    const deadline = startDeadline(1000, controller.signal, clock);
    using stage = deadline.startStage(250);

    controller.abort(reason);

    expect(stage.signal.reason).toBe(reason);
  });

  it("clears its timer when disposed", () => {
    const { clock, pendingTimers } = manualClock();
    using _deadline = startDeadline(1000, undefined, clock);

    {
      using _stage = _deadline.startStage(250);
      expect(pendingTimers()).toBe(2);
    }

    expect(pendingTimers()).toBe(1);
  });
});
