import { describe, expect, it } from "vite-plus/test";

import { startInOrder, stopInReverse } from "./start-stop.ts";
import type { Startable } from "./start-stop.ts";

const tracked = (
  name: string,
  calls: string[],
  options: { failStart?: boolean; failStop?: boolean } = {},
): Startable => ({
  start: () => {
    calls.push(`start ${name}`);

    if (options.failStart === true) {
      throw new Error(`${name} start failed`);
    }
  },
  stop: () => {
    calls.push(`stop ${name}`);

    if (options.failStop === true) {
      throw new Error(`${name} stop failed`);
    }
  },
});

describe(startInOrder, () => {
  it("starts items one after another, skipping items without a start hook", async () => {
    const calls: string[] = [];

    await startInOrder([tracked("a", calls), {}, tracked("b", calls)]);

    expect(calls).toStrictEqual(["start a", "start b"]);
  });

  it("stops the already-started items in reverse and rethrows the start failure", async () => {
    const calls: string[] = [];

    const attempt = startInOrder([
      tracked("a", calls),
      tracked("b", calls),
      tracked("c", calls, { failStart: true }),
      tracked("d", calls),
    ]);

    await expect(attempt).rejects.toThrow("c start failed");
    expect(calls).toStrictEqual(["start a", "start b", "start c", "stop b", "stop a"]);
  });

  it("still reports the start failure when cleanup itself fails", async () => {
    const calls: string[] = [];

    const attempt = startInOrder([
      tracked("a", calls, { failStop: true }),
      tracked("b", calls, { failStart: true }),
    ]);

    await expect(attempt).rejects.toThrow("b start failed");
    expect(calls).toContain("stop a");
  });
});

describe(stopInReverse, () => {
  it("stops items last-started first and tolerates items without a stop hook", async () => {
    const calls: string[] = [];

    await stopInReverse([tracked("a", calls), {}, tracked("b", calls)]);

    expect(calls).toStrictEqual(["stop b", "stop a"]);
  });

  it("stops everything even when some fail, then throws the first failure", async () => {
    const calls: string[] = [];

    const attempt = stopInReverse([
      tracked("a", calls),
      tracked("b", calls, { failStop: true }),
      tracked("c", calls, { failStop: true }),
    ]);

    await expect(attempt).rejects.toThrow("c stop failed");
    expect(calls).toStrictEqual(["stop c", "stop b", "stop a"]);
  });

  it("wraps a thrown non-Error so callers always receive an Error", async () => {
    const attempt = stopInReverse([
      {
        stop: () => {
          // oxlint-disable-next-line typescript/only-throw-error, no-throw-literal -- proving non-Error throws are normalized
          throw "plain string";
        },
      },
    ]);

    await expect(attempt).rejects.toMatchObject({ cause: "plain string", message: "plain string" });
  });
});
