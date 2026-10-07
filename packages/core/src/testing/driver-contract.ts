import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline, untilDeadline } from "../deadline.ts";
import type { Deadline } from "../deadline.ts";
import {
  createScratchDir,
  prepareProfile,
  removeScratchDir,
} from "../sources/browser/browser-process.ts";
import { killProcessGroup, waitForGroupExit } from "../sources/browser/group-lifetime.ts";
import { planLaunch } from "../sources/browser/launch-plan.ts";
import { settleWithin } from "../sources/browser/lifetime.ts";
import type { BrowserDriver, DriverBrowser, DriverEvent } from "../sources/browser/port.ts";
import { chromePath } from "./chrome-path.ts";
import { startFixtureServer } from "./fixture-server.ts";
import { killRenderers } from "./processes.ts";

export const DRIVER_GUARANTEES = [
  "no-page-events-before-navigate",
  "in-flight-reject-on-crash",
  "isolated-world-per-document",
  "evaluate-error-message",
  "owned-before-launch-settles",
  "close-bounded",
  "parsed-product",
] as const;

type DriverGuarantee = (typeof DRIVER_GUARANTEES)[number];

const VERSION = /^\d+(?:\.\d+){3}$/u;

const TEST_BUDGET_MS = 10_000;

const CRASH_BUDGET_MS = 2000;

const CLOSE_BUDGET_MS = 500;

const CLEANUP_BUDGET_MS = 2000;

const EXIT_BUDGET_MS = 5000;

const SCHEDULER_ALLOWANCE_MS = 150;

const EARLY_EXIT_MARGIN_MS = 10;

const STARTUP_SETTLE_MS = 100;

const isText = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number";

interface ContractVisit {
  readonly browser: DriverBrowser;
  readonly deadline: Deadline;
  readonly origin: string;
  readonly profile: string;
  readonly pid: number;
  readonly ownershipEvents: readonly string[];
  readonly pendingStarted: Promise<boolean>;
}

const withDriver = async (
  driver: BrowserDriver,
  check: (visit: ContractVisit) => void | Promise<void>,
): Promise<void> => {
  const started = Promise.withResolvers<boolean>();

  await using fixture = await startFixtureServer((request, response) => {
    if (request.url === "/started") {
      started.resolve(true);
    }

    response.end("<script>globalThis.pageOnly = 88</script><p>Driver contract</p>");
  });

  using deadline = startDeadline(TEST_BUDGET_MS);
  const scratch = await createScratchDir(Date.now());

  const plan = planLaunch({
    browserPath: chromePath(),
    display: process.env.DISPLAY,
    headless: true,
    platform: process.platform,
    scratchDir: scratch.path,
    timezone: process.env.TZ,
    xauthority: process.env.XAUTHORITY,
  });

  const cleanups: Promise<void>[] = [];
  const ownershipEvents: string[] = [];
  let pid: number | undefined;
  let browser: DriverBrowser | undefined;

  try {
    await prepareProfile(plan);
    browser = await driver.launch(
      plan,
      deadline,
      (reported) => {
        ownershipEvents.push("owned");
        pid = reported;
      },
      (cleanup) => {
        cleanups.push(cleanup);
      },
    );
    ownershipEvents.push("settled");

    if (pid === undefined) {
      throw new Error("A successful driver launch did not report a known process group.");
    }

    await check({
      browser,
      deadline,
      origin: fixture.origin,
      ownershipEvents,
      pendingStarted: started.promise,
      pid,
      profile: plan.directories.profile,
    });
  } finally {
    await settleWithin(Promise.allSettled(cleanups), CLEANUP_BUDGET_MS);
    await settleWithin(browser?.close(CLEANUP_BUDGET_MS) ?? Promise.resolve(), CLEANUP_BUDGET_MS);

    if (pid !== undefined) {
      killProcessGroup(pid);
    }

    if (pid !== undefined && !(await waitForGroupExit(pid, AbortSignal.timeout(EXIT_BUDGET_MS)))) {
      expect.fail(`The contract fixture left process group ${pid} running.`);
    }

    await removeScratchDir(scratch);
  }
};

const checks: Record<DriverGuarantee, (visit: ContractVisit) => void | Promise<void>> = {
  "close-bounded": async ({ browser, pid }) => {
    const start = performance.now();
    await browser.close(CLOSE_BUDGET_MS);
    const elapsed = performance.now() - start;
    const gone = await waitForGroupExit(pid, AbortSignal.timeout(CLOSE_BUDGET_MS));
    expect(elapsed).toBeLessThan(CLOSE_BUDGET_MS + SCHEDULER_ALLOWANCE_MS);
    expect({
      gone,
      returnedEarly: elapsed < CLOSE_BUDGET_MS - EARLY_EXIT_MARGIN_MS,
    }).not.toStrictEqual({
      gone: false,
      returnedEarly: true,
    });
  },
  "evaluate-error-message": async ({ browser, deadline, origin }) => {
    await browser.navigate(`${origin}/document`, deadline);
    await expect(
      browser.evaluateIsolated(
        '(() => { throw new Error("driver contract failure message"); })()',
        isText,
        deadline,
      ),
    ).rejects.toThrow("driver contract failure message");
  },
  "in-flight-reject-on-crash": async ({ browser, origin, pendingStarted, profile }) => {
    using deadline = startDeadline(CRASH_BUDGET_MS);
    await browser.navigate(`${origin}/document`, deadline);

    const pending = browser.evaluateIsolated(
      'new Promise(() => { fetch("/started"); })',
      isText,
      deadline,
    );

    const rejected = expect(pending).rejects.toMatchObject({
      reason: { kind: "browser-gone" },
    });

    await untilDeadline(async () => {
      await pendingStarted;
    }, deadline);
    expect(await killRenderers(profile)).toBeGreaterThan(0);
    await rejected;
  },
  "isolated-world-per-document": async ({ browser, deadline, origin }) => {
    await browser.navigate(`${origin}/document`, deadline);
    expect(await browser.evaluateIsolated("typeof globalThis.pageOnly", isText, deadline)).toBe(
      "undefined",
    );
    expect(
      await browser.evaluateIsolated("globalThis.contractState = 177", isNumber, deadline),
    ).toBe(177);
    expect(await browser.evaluateIsolated("globalThis.contractState", isNumber, deadline)).toBe(
      177,
    );
    await browser.navigate(`${origin}/next-document`, deadline);
    expect(
      await browser.evaluateIsolated("typeof globalThis.contractState", isText, deadline),
    ).toBe("undefined");
  },
  "no-page-events-before-navigate": async ({ browser, deadline, origin }) => {
    const events: DriverEvent[] = [];
    const committed = Promise.withResolvers<boolean>();

    const unsubscribe = browser.onEvent((event) => {
      events.push(event);

      if (event.type === "commit") {
        committed.resolve(true);
      }
    });

    try {
      expect(await browser.evaluateIsolated("1", isNumber, deadline)).toBe(1);
      await delay(STARTUP_SETTLE_MS);
      expect(events).toStrictEqual([]);
      await browser.navigate(`${origin}/document`, deadline);
      expect(await untilDeadline(async () => await committed.promise, deadline)).toBe(true);
    } finally {
      unsubscribe();
    }
  },
  "owned-before-launch-settles": ({ ownershipEvents, pid }) => {
    expect(ownershipEvents).toStrictEqual(["owned", "settled"]);
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  },
  "parsed-product": ({ browser }) => {
    expect(Number.isSafeInteger(browser.product.major) && browser.product.major > 0).toBe(true);
    expect(browser.product.version).toMatch(VERSION);
    expect(Number(browser.product.version.split(".")[0])).toBe(browser.product.major);
    expect([true, false]).toContain(browser.product.headless);
  },
};

export const defineDriverContract = (driver: BrowserDriver): void => {
  describe("driver contract", () => {
    for (const guarantee of DRIVER_GUARANTEES) {
      it(guarantee, async () => {
        await withDriver(driver, checks[guarantee]);
      });
    }
  });
};
