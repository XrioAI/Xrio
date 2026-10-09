import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { resolveClientOptions, resolveScrapeIntent } from "../options.ts";
import { anonymousSessions } from "../testing/anonymous-sessions.ts";
import { createSessions } from "./session.ts";

const browser = resolveScrapeIntent(
  { format: "html", url: "https://example.com" },
  resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
);

const profileUse = async () => await Promise.resolve("clear" as const);

const OPEN_SETTLE_MS = 100;

const seed = () => "9f2c41d07a3be815";

describe(anonymousSessions, () => {
  it("draws a fresh device and holds ownership until it is released", async () => {
    using deadline = startDeadline(1000);

    const hold = await anonymousSessions().hold(
      browser.session,
      { seed: () => "9f2c41d07a3be815" },
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

describe(createSessions, () => {
  it("rejects an expired hold with TIMEOUT without opening a state directory that would fail", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-session-"));
    const file = path.join(root, "file");
    await writeFile(file, "");
    const sessions = createSessions(path.join(file, "state"), { profileUse });
    let unhandled = 0;

    const recordUnhandled = () => {
      unhandled += 1;
    };

    process.on("unhandledRejection", recordUnhandled);

    try {
      using deadline = startDeadline(0);

      await expect(
        sessions.hold(
          { kind: "named", name: "account" },
          { seed: () => "9f2c41d07a3be815" },
          deadline,
        ),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      await delay(OPEN_SETTLE_MS);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
      await sessions.close();
      await rm(root, { force: true, recursive: true });
    }

    expect(unhandled).toBe(0);
  });

  it("gives a new session and a redraw only sticky ids that no other session holds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-session-"));
    const sessions = createSessions(root, { profileUse });
    const draws = ["taken", "taken", "unused", "unused", "spare"];
    const stickyId = () => draws.shift() ?? "exhausted";
    using deadline = startDeadline(10_000);

    try {
      await using first = await sessions.hold(
        { kind: "named", name: "first" },
        { seed, stickyId },
        deadline,
      );

      await using second = await sessions.hold(
        { kind: "named", name: "second" },
        { seed, stickyId },
        deadline,
      );

      expect({
        first: first.binding?.stickyId,
        redrawn: second.drawStickyId(),
        second: second.binding?.stickyId,
      }).toStrictEqual({ first: "taken", redrawn: "spare", second: "unused" });
      await expect(
        sessions.hold(
          { kind: "named", name: "third" },
          { seed, stickyId: () => "taken" },
          deadline,
        ),
      ).rejects.toMatchObject({ code: "PROXY_SESSION_GENERATION_FAILED" });
    } finally {
      await sessions.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
