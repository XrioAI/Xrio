import { describe, expect, it } from "vite-plus/test";

import { withinSignal } from "./lifetime.ts";

describe("operation lifetime", () => {
  it("does not start an operation after cancellation", async () => {
    const reason = new Error("Canceled before starting");
    let starts = 0;

    const result = withinSignal(async () => {
      starts += 1;

      return await Promise.resolve("started");
    }, AbortSignal.abort(reason));

    await expect(result).rejects.toBe(reason);
    expect(starts).toBe(0);
  });

  it("rejects a pending operation with the caller's cancellation reason", async () => {
    const controller = new AbortController();
    const reason = new Error("Canceled while pending");
    const pending = Promise.withResolvers<string>();
    const result = withinSignal(async () => await pending.promise, controller.signal);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    pending.resolve("finished after cancellation");
  });

  it("handles cancellation triggered synchronously by starting the operation", async () => {
    const controller = new AbortController();
    const reason = new Error("Canceled during startup");
    const pending = Promise.withResolvers<string>();

    const result = withinSignal(async () => {
      controller.abort(reason);

      return await pending.promise;
    }, controller.signal);

    await expect(result).rejects.toBe(reason);
    pending.resolve("finished after cancellation");
  });

  it("preserves an operation's rejection", async () => {
    const reason = new Error("Operation failed");

    const result = withinSignal(
      async () => await Promise.reject(reason),
      new AbortController().signal,
    );

    await expect(result).rejects.toBe(reason);
  });

  it("preserves an error thrown synchronously while starting", async () => {
    const reason = new Error("Startup failed");

    const result = withinSignal(() => {
      throw reason;
    }, new AbortController().signal);

    await expect(result).rejects.toBe(reason);
  });
});
