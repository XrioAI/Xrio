import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { parseProxy, resolveClientOptions, resolveScrapeIntent } from "../options.ts";
import { anonymousSessions } from "../testing/anonymous-sessions.ts";
import { attemptLog } from "../testing/attempt-log.ts";
import type { ProxyEndpoint } from "../types.ts";
import { createSessions } from "./session.ts";

const browser = resolveScrapeIntent(
  { format: "html", url: "https://example.com" },
  resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
);

const profileUse = async () => await Promise.resolve("clear" as const);

const OPEN_SETTLE_MS = 100;

const seed = () => "9f2c41d07a3be815";

const reportedProxy = (
  session: { readonly name: string; readonly proxy?: string } | undefined,
) => ({
  name: session?.name,
  proxy: session !== undefined && Object.hasOwn(session, "proxy") ? session.proxy : "none",
});

const served = {
  challengeOutcome: null,
  challengeRules: [],
  deviceDigest: "digest",
  exitAddress: "203.0.113.7",
  site: "example.com",
  vendor: null,
  verdict: "ok",
} as const;

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

  it("stores a visit's proxy URL with its password and reports it without the password", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-session-"));
    const sessions = createSessions(root, { profileUse });
    const capabilities = { chromeMajor: 154, permittedCpus: 8, platform: "linux" } as const;
    const proxy = parseProxy("http://user-sticky:secret@proxy.test:8000");
    using deadline = startDeadline(10_000);

    const finished = async (name: string, used: ProxyEndpoint | null) => {
      await using hold = await sessions.hold(
        { kind: "named", name },
        { capabilities, seed },
        deadline,
      );

      const summary = hold.summary(served, { browserArgs: [], proxy: used ?? undefined });

      await hold.finish({
        ...attemptLog({ proxyUrl: used?.url ?? null }),
        browserArgs: [],
        closed: { exited: true },
        record: null,
        siteVisit: served,
      });

      return summary;
    };

    try {
      const summaries = [await finished("direct", null), await finished("proxied", proxy)];
      const listed = await sessions.admin.list();
      const database = new DatabaseSync(path.join(root, "xrio.db"), { readOnly: true });

      try {
        expect({
          listed: listed.map(reportedProxy),
          stored: database
            .prepare("SELECT name,proxy_url FROM sessions ORDER BY name")
            .all()
            .map((row) => ({ ...row })),
          summaries: summaries.map(reportedProxy),
        }).toStrictEqual({
          listed: [
            { name: "direct", proxy: "none" },
            { name: "proxied", proxy: "http://user-sticky@proxy.test:8000/" },
          ],
          stored: [
            { name: "direct", proxy_url: null },
            { name: "proxied", proxy_url: "http://user-sticky:secret@proxy.test:8000/" },
          ],
          summaries: [
            { name: "direct", proxy: "none" },
            { name: "proxied", proxy: "http://user-sticky@proxy.test:8000/" },
          ],
        });
      } finally {
        database.close();
      }
    } finally {
      await sessions.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
