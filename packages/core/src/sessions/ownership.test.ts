import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import type { Clock } from "../deadline.ts";
import { resolveClientOptions, resolveScrapeIntent } from "../options.ts";
import { createSessions } from "./session.ts";

interface Timer {
  readonly at: number;
  readonly run: () => void;
}

const stalledClock = () => {
  let now = 0;
  const timers = new Set<Timer>();

  const clock: Clock = {
    now: () => now,
    setTimer: (delayMs, run) => {
      const timer = { at: now + delayMs, run };
      timers.add(timer);

      return () => {
        timers.delete(timer);
      };
    },
  };

  const nextDue = (): Timer | undefined => {
    let first: Timer | undefined;

    for (const timer of timers) {
      if (timer.at <= now && (first === undefined || timer.at < first.at)) {
        first = timer;
      }
    }

    return first;
  };

  const runNext = () => {
    const timer = nextDue();

    if (timer === undefined) {
      return false;
    }

    timers.delete(timer);
    timer.run();

    return true;
  };

  return {
    clock,
    jump: (time: number) => {
      now = time;
    },
    runDue: () => {
      while (runNext()) {
        continue;
      }
    },
    runNext,
  };
};

const heldSession = async (wallClock?: () => number) => {
  const root = await mkdtemp(path.join(tmpdir(), "xrio-ownership-"));
  const time = stalledClock();
  const deadline = startDeadline(120_000, undefined, time.clock);

  const sessions = createSessions(root, {
    profileUse: async () => await Promise.resolve("clear" as const),
    wallNow: wallClock ?? time.clock.now,
  });

  const intent = resolveScrapeIntent(
    { format: "html", session: "account", url: "https://example.com" },
    resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
  );

  const hold = await sessions.hold(intent.session, { seed: () => "9f2c41d07a3be815" }, deadline);

  const database = new DatabaseSync(path.join(root, "xrio.db"));
  database.exec("PRAGMA busy_timeout=0");

  return {
    close: async () => {
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }

      time.jump(120_000);
      time.runDue();
      await hold[Symbol.asyncDispose]();
      await sessions.close();
      deadline[Symbol.dispose]();
      database.close();
      await rm(root, { force: true, recursive: true });
    },
    database,
    expiry: () =>
      database
        .prepare("SELECT expires_at FROM sessions WHERE tenant='local' AND name='account'")
        .get()?.expires_at,
    held: hold.bind(deadline),
    hold,
    time,
  };
};

describe("session ownership", () => {
  it("an overdue renewal cannot resurrect ownership before the queued abort runs", async () => {
    const visit = await heldSession();

    try {
      expect(visit.expiry()).toBe(60_000);
      visit.time.jump(55_000);
      visit.time.runNext();
      await Promise.resolve();
      expect(visit.held.abortReason()).toBe("ownership");
      expect(() => {
        visit.held.throwIfExpired();
      }).toThrow("ownership-lost");
      expect(visit.expiry()).toBe(60_000);
    } finally {
      await visit.close();
    }
  });

  it("refuses a finished visit after local expiry even before its abort timer runs", async () => {
    const visit = await heldSession();

    try {
      visit.time.jump(55_000);
      await expect(
        visit.hold.finish({ browserArgs: [], closed: { exited: true }, record: null }),
      ).rejects.toMatchObject({
        code: "SESSION_UNAVAILABLE",
        details: { reason: "ownership-lost" },
      });
      expect(visit.held.abortReason()).toBe("ownership");
      expect(visit.expiry()).toBe(60_000);
    } finally {
      await visit.close();
    }
  });

  it("treats a hold as lost once wall time passes its expiry while the monotonic clock slept", async () => {
    let wall = 0;
    const visit = await heldSession(() => wall);

    try {
      wall = 55_000;
      await expect(
        visit.hold.finish({ browserArgs: [], closed: { exited: true }, record: null }),
      ).rejects.toMatchObject({
        code: "SESSION_UNAVAILABLE",
        details: { reason: "ownership-lost" },
      });
      expect(visit.held.abortReason()).toBe("ownership");
      expect(visit.expiry()).toBe(60_000);
    } finally {
      await visit.close();
    }
  });

  it("a delayed renewal retains the local abort time of the expiry it wrote", async () => {
    const visit = await heldSession();

    try {
      visit.database.exec("BEGIN IMMEDIATE");
      visit.time.jump(20_000);
      visit.time.runNext();
      visit.time.jump(30_000);
      visit.database.exec("COMMIT");
      visit.time.runNext();
      await expect.poll(visit.expiry).toBe(80_000);
      visit.database.exec("BEGIN IMMEDIATE");
      visit.time.jump(50_000);
      visit.time.runNext();
      visit.time.jump(70_000);
      visit.time.runDue();
      expect(visit.held.abortReason()).toBe("ownership");
      expect(() => {
        visit.held.throwIfExpired();
      }).toThrow("ownership-lost");
      expect(visit.expiry()).toBe(80_000);
    } finally {
      await visit.close();
    }
  });
});
