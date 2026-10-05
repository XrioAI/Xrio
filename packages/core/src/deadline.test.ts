import { describe, expect, it } from "vite-plus/test";

import { startDeadline, untilDeadline } from "./deadline.ts";
import { manualClock } from "./testing/manual-clock.ts";

const deadlineAfter = (elapsedMs: number) => {
  const { advance, clock } = manualClock();
  const deadline = startDeadline(1000, undefined, clock);

  advance(elapsedMs);

  return deadline;
};

describe(startDeadline, () => {
  it("after 0 ms, 1000 ms remain and a 250 ms stage keeps its own 250 ms timer", () => {
    const deadline = deadlineAfter(0);

    expect(deadline.remainingMs()).toBe(1000);
    expect(deadline.stageTimeout(250)).toBe(250);
  });

  it.each([
    { elapsedMs: 900, remainingMs: 100 },
    { elapsedMs: 999.5, remainingMs: 1 },
  ])(
    "after $elapsedMs ms, $remainingMs ms remain and a 250 ms stage is left to the deadline",
    ({ elapsedMs, remainingMs }) => {
      const deadline = deadlineAfter(elapsedMs);

      expect(deadline.remainingMs()).toBe(remainingMs);
      expect(deadline.stageTimeout(250)).toBeUndefined();
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

  it("aborts a deadline-capped stage with TIMEOUT when timers fire just before the deadline", () => {
    let now = 0;
    const timers: (() => void)[] = [];

    const clock = {
      now: () => now,
      setTimer: (_delayMs: number, onTimeout: () => void) => {
        timers.push(onTimeout);

        return () => {};
      },
    };

    const deadline = startDeadline(1000, undefined, clock);

    now = 900;
    using stage = deadline.startStage(250);

    now = 999.5;

    for (const onTimeout of timers.toReversed()) {
      onTimeout();
    }

    expect(stage.signal.reason).toMatchObject({ code: "TIMEOUT" });
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

describe(untilDeadline, () => {
  it("never starts work once the clock has passed the deadline, before its timer fires", async () => {
    let now = 0;
    const clock = { now: () => now, setTimer: () => () => {} };
    const deadline = startDeadline(1000, undefined, clock);
    const started: string[] = [];

    now = 1000;

    await expect(
      untilDeadline(async () => {
        started.push("work");

        return await Promise.resolve("done");
      }, deadline),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(started).toStrictEqual([]);
  });

  it("settles with the deadline's reason while the work is still pending", async () => {
    const { advance, clock } = manualClock();
    const deadline = startDeadline(1000, undefined, clock);
    const work = Promise.withResolvers<string>();
    const settled = untilDeadline(async () => await work.promise, deadline);

    advance(1000);

    await expect(settled).rejects.toMatchObject({ code: "TIMEOUT" });
    work.reject(new Error("The abandoned work failed later."));
  });

  it("reports the deadline's reason for work that fails as the deadline passes", async () => {
    let now = 0;
    const clock = { now: () => now, setTimer: () => () => {} };
    const deadline = startDeadline(1000, undefined, clock);

    const settled = untilDeadline(async () => {
      now = 1000;

      return await Promise.reject(new Error("The driver's own timeout fired first."));
    }, deadline);

    await expect(settled).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("rejects with the caller's reason when the caller aborts", async () => {
    const { clock } = manualClock();
    const controller = new AbortController();
    const reason = new Error("Stopped by caller");
    const deadline = startDeadline(1000, controller.signal, clock);

    const settled = untilDeadline(
      async () => await Promise.withResolvers<string>().promise,
      deadline,
    );

    controller.abort(reason);

    await expect(settled).rejects.toBe(reason);
  });

  it("keeps the work's own error while the deadline is live", async () => {
    const { clock } = manualClock();
    const deadline = startDeadline(1000, undefined, clock);
    const failure = new Error("The browser refused.");

    await expect(untilDeadline(async () => await Promise.reject(failure), deadline)).rejects.toBe(
      failure,
    );
  });
});
