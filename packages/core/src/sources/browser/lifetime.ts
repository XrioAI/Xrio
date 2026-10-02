export const withinSignal = async <Result>(
  start: () => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> => {
  signal.throwIfAborted();
  const interrupted = Promise.withResolvers<never>();

  const abort = () => {
    interrupted.reject(signal.reason);
  };

  signal.addEventListener("abort", abort, { once: true });

  try {
    const operation = (async () => await start())();

    if (signal.aborted) {
      abort();
    }

    return await Promise.race([operation, interrupted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

export const settleWithin = async (
  operation: Promise<unknown>,
  budgetMs: number,
): Promise<void> => {
  const timer = new AbortController();

  const expiry = setTimeout(() => {
    timer.abort(new Error("Cleanup exceeded its budget."));
  }, budgetMs);

  try {
    await Promise.allSettled([withinSignal(async () => await operation, timer.signal)]);
  } finally {
    clearTimeout(expiry);
  }
};
