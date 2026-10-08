import type { Deadline } from "../../deadline.ts";

export const pollAfter = async (delayMs: number, deadline: Deadline): Promise<void> => {
  deadline.throwIfExpired();
  const { promise, resolve, reject } = Promise.withResolvers<null>();

  const cancel = deadline.clock.setTimer(delayMs, () => {
    resolve(null);
  });

  const abort = () => {
    reject(deadline.signal.reason);
  };

  deadline.signal.addEventListener("abort", abort, { once: true });

  if (deadline.signal.aborted) {
    abort();
  }

  try {
    await promise;
  } finally {
    cancel();
    deadline.signal.removeEventListener("abort", abort);
  }
};
