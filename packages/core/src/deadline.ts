import { isXrioError, XrioError } from "./errors.ts";

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

export type AbortReason = "expired" | "caller" | "ownership" | "client-closed";

export interface Deadline {
  readonly abortReason: () => AbortReason | undefined;
  readonly signal: AbortSignal;
  readonly remainingMs: () => number;
  readonly throwIfExpired: () => void;
  readonly stageTimeout: (capMs: number) => number | undefined;
  readonly startStage: (capMs: number) => Stage;
  readonly boundTo: (signal: AbortSignal, reason?: AbortReason) => Deadline;
}

interface Expiry {
  readonly clock: Clock;
  readonly expire: () => void;
  readonly remainingMs: () => number;
}

interface AbortSource {
  readonly signal: AbortSignal;
  readonly reason: () => AbortReason | undefined;
}

const joinedAbort = (sources: readonly AbortSource[]): AbortSource => {
  const signal = AbortSignal.any(sources.map((source) => source.signal));
  let reason: AbortReason | undefined;

  const rememberWinner = () => {
    reason = sources
      .find((source) => source.signal.aborted && source.signal.reason === signal.reason)
      ?.reason();
  };

  if (signal.aborted) {
    rememberWinner();
  } else {
    signal.addEventListener("abort", rememberWinner, { once: true });
  }

  return { reason: () => reason, signal };
};

const observeExpiry = (expiry: Expiry, aborted: AbortSource): Deadline => {
  const { signal } = aborted;
  const { clock, expire, remainingMs } = expiry;

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

  const stageTimeout = (capMs: number) => (capMs < remainingMsOrThrow() ? capMs : undefined);

  const startStage = (capMs: number): Stage => {
    const stageMs = stageTimeout(capMs);
    const stage = new AbortController();

    const abortWithDeadline = () => {
      stage.abort(signal.reason);
    };

    signal.addEventListener("abort", abortWithDeadline, { once: true });

    const cancelStageTimer =
      stageMs === undefined
        ? undefined
        : clock.setTimer(stageMs, () => {
            if (remainingMs() === 0) {
              expire();
            }

            stage.abort(new Error(`The stage did not finish within ${stageMs} ms.`));
          });

    return {
      [Symbol.dispose]: () => {
        cancelStageTimer?.();
        signal.removeEventListener("abort", abortWithDeadline);
      },
      signal: stage.signal,
    };
  };

  return {
    abortReason: aborted.reason,
    boundTo: (other, reason = "caller") =>
      observeExpiry(expiry, joinedAbort([aborted, { reason: () => reason, signal: other }])),
    remainingMs,
    signal,
    stageTimeout,
    startStage,
    throwIfExpired,
  };
};

export const startDeadline = (
  timeoutMs: number,
  callerSignal?: AbortSignal,
  clock: Clock = systemClock,
): Deadline & Disposable => {
  const expiresAt = clock.now() + timeoutMs;
  const expiry = new AbortController();

  const expirySource: AbortSource = {
    reason: () => (expiry.signal.aborted ? "expired" : undefined),
    signal: expiry.signal,
  };

  const aborted =
    callerSignal === undefined
      ? expirySource
      : joinedAbort([{ reason: () => "caller", signal: callerSignal }, expirySource]);

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

  return {
    ...observeExpiry({ clock, expire, remainingMs }, aborted),
    [Symbol.dispose]: cancelTimer,
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
    if (isXrioError(error)) {
      throw error;
    }

    deadline.throwIfExpired();
    throw error;
  } finally {
    deadline.signal.removeEventListener("abort", abort);
  }
};
