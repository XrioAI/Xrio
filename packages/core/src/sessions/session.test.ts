import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { resolveClientOptions, resolveScrapeIntent } from "../options.ts";
import { anonymousSessions } from "./session.ts";

const browser = resolveScrapeIntent(
  { format: "html", url: "https://example.com" },
  resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
);

describe(anonymousSessions, () => {
  it("draws a fresh device and holds ownership until it is released", async () => {
    using deadline = startDeadline(1000);

    const hold = await anonymousSessions().hold(
      browser.session,
      { identity: browser.identity, seed: () => "9f2c41d07a3be815", source: browser.source },
      deadline,
    );

    const held = hold.bind(deadline);

    expect(hold.device).toStrictEqual({ kind: "fresh", seed: "9f2c41d07a3be815" });
    expect(held.signal.aborted).toBeFalsy();
    await hold[Symbol.asyncDispose]();
    await hold[Symbol.asyncDispose]();
    expect([held.signal.aborted, held.abortReason(), deadline.signal.aborted]).toStrictEqual([
      true,
      "ownership",
      false,
    ]);
  });
});
