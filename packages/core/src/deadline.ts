import { XrioError } from "./errors.ts";

export interface Clock {
  readonly now: () => number;
  readonly setTimer: (delayMs: number, onTimeout: () => void) => () => void;
}

const systemClock: Clock = {
  now: () => performance.now(),
  setTimer: (delayMs, onTimeout) => {
    const timer = setTimeout(onTimeout, delayMs);

    return () => {
      clearTimeout(timer);
    };
  },
};

interface Stage extends Disposable {
  readonly signal: AbortSignal;
}

export interface Deadline extends Disposable {
  readonly signal: AbortSignal;
  readonly remainingMs: () => number;
  readonly throwIfExpired: () => void;
  readonly stageTimeout: (capMs: number) => number;
  readonly startStage: (capMs: number) => Stage;
}

export const startDeadline = (
  timeoutMs: number,
  callerSignal?: AbortSignal,
  clock: Clock = systemClock,
): Deadline => {
  const expiresAt = clock.now() + timeoutMs;
  const expiry = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, expiry.signal]) : expiry.signal;

  const expire = () => {
    if (!expiry.signal.aborted) {
      expiry.abort(
        new XrioError("TIMEOUT", `The scrape did not finish within ${timeoutMs} ms.`, {
          details: undefined,
        }),
      );
    }
  };

  const cancelTimer = clock.setTimer(timeoutMs, expire);
  const remainingMs = () => Math.max(0, Math.ceil(expiresAt - clock.now()));

  const remainingMsOrThrow = () => {
    const remaining = remainingMs();

    if (remaining === 0) {
      expire();
    }

    signal.throwIfAborted();

    return remaining;
  };

  const throwIfExpired = () => {
    remainingMsOrThrow();
  };

  const stageTimeout = (capMs: number) => Math.max(1, Math.min(capMs, remainingMsOrThrow()));

  const startStage = (capMs: number): Stage => {
    const stageMs = stageTimeout(capMs);
    const stage = new AbortController();

    const abortWithDeadline = () => {
      stage.abort(signal.reason);
    };

    signal.addEventListener("abort", abortWithDeadline, { once: true });

    const cancelStageTimer = clock.setTimer(stageMs, () => {
      if (remainingMs() === 0) {
        expire();
      }

      stage.abort(new Error(`The stage did not finish within ${stageMs} ms.`));
    });

    return {
      [Symbol.dispose]: () => {
        cancelStageTimer();
        signal.removeEventListener("abort", abortWithDeadline);
      },
      signal: stage.signal,
    };
  };

  return {
    [Symbol.dispose]: cancelTimer,
    remainingMs,
    signal,
    stageTimeout,
    startStage,
    throwIfExpired,
  };
};

export const untilDeadline = async <Result>(
  start: () => Promise<Result>,
  deadline: Deadline,
): Promise<Result> => {
  deadline.throwIfExpired();
  const operation = start();
  const expired = Promise.withResolvers<never>();

  const abort = () => {
    expired.reject(deadline.signal.reason);
  };

  deadline.signal.addEventListener("abort", abort, { once: true });

  if (deadline.signal.aborted) {
    abort();
  }

  try {
    return await Promise.race([operation, expired.promise]);
  } catch (error) {
    deadline.throwIfExpired();
    throw error;
  } finally {
    deadline.signal.removeEventListener("abort", abort);
  }
};
