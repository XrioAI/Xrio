import type { Deadline } from "./deadline.ts";
import type { ErrorCode } from "./errors.ts";
import { isXrioError } from "./errors.ts";
import { pollAfter } from "./poll.ts";

const MINIMUM_ATTEMPT_MS = 1000;

const INITIAL_BACKOFF_MS = 1000;

const MAXIMUM_BACKOFF_MS = 30_000;

const RETRYABLE_ERRORS = new Set<ErrorCode>([
  "NETWORK_ERROR",
  "PROXY_UNREACHABLE",
  "PROXY_CONNECT_FAILED",
  "BROWSER_CRASHED",
]);

export interface Retries {
  readonly next: (error: Error) => number | undefined;
  readonly wait: (delayMs: number) => Promise<boolean>;
}

export const createRetries = (count: number, deadline: Deadline, random: () => number): Retries => {
  let used = 0;

  const next = (error: Error): number | undefined => {
    if (
      used >= count ||
      deadline.signal.aborted ||
      deadline.remainingMs() < MINIMUM_ATTEMPT_MS ||
      !isXrioError(error) ||
      !RETRYABLE_ERRORS.has(error.code)
    ) {
      return undefined;
    }

    const delayMs = random() * Math.min(MAXIMUM_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** used);
    used += 1;

    return delayMs + MINIMUM_ATTEMPT_MS <= deadline.remainingMs() ? delayMs : 0;
  };

  const wait = async (delayMs: number): Promise<boolean> => {
    deadline.throwIfExpired();

    if (deadline.remainingMs() < MINIMUM_ATTEMPT_MS) {
      return false;
    }

    if (delayMs > 0 && delayMs + MINIMUM_ATTEMPT_MS <= deadline.remainingMs()) {
      await pollAfter(delayMs, deadline);
    }

    deadline.throwIfExpired();

    return deadline.remainingMs() >= MINIMUM_ATTEMPT_MS;
  };

  return { next, wait };
};
