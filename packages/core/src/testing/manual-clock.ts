import type { Clock } from "../deadline.ts";

interface Timer {
  readonly at: number;
  readonly onTimeout: () => void;
}

export const manualClock = () => {
  let now = 0;
  const timers = new Set<Timer>();

  const clock: Clock = {
    now: () => now,
    setTimer: (delayMs, onTimeout) => {
      const timer = { at: now + delayMs, onTimeout };
      timers.add(timer);

      return () => {
        timers.delete(timer);
      };
    },
  };

  const nextDueBy = (time: number): Timer | undefined => {
    let next: Timer | undefined;

    for (const timer of timers) {
      if (timer.at <= time && (next === undefined || timer.at < next.at)) {
        next = timer;
      }
    }

    return next;
  };

  const advance = (ms: number) => {
    const target = now + ms;

    for (let timer = nextDueBy(target); timer !== undefined; timer = nextDueBy(target)) {
      timers.delete(timer);
      now = timer.at;
      timer.onTimeout();
    }

    now = target;
  };

  return { advance, clock, pendingTimers: () => timers.size };
};
