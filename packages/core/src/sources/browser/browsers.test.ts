import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startDeadline, untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import { isXrioError } from "../../errors.ts";
import type { Observation } from "../../humanizer/contracts.ts";
import { planIdentity } from "../../humanizer/humanizer.ts";
import { AFTER_CAPTURE_READ, evaluate } from "../../humanizer/verify.ts";
import { sessionFor } from "../../sessions/session.ts";
import { fakeChromePath } from "../../testing/fake-chrome-path.ts";
import { leftovers, nothingLeft, ownedScratchDirs } from "../../testing/leftovers.ts";
import { manualClock } from "../../testing/manual-clock.ts";
import { noPins } from "../../testing/no-pins.ts";
import { stageTimeline } from "../../testing/stage-timeline.ts";
import { scratchRoot } from "./browser-process.ts";
import { createBrowsers } from "./browsers.ts";
import { cdpDriver } from "./cdp/driver.ts";
import type { RetireSteps } from "./chrome-scope.ts";
import { killProcessGroup, waitForGroupExit } from "./group-lifetime.ts";
import type { LaunchPlan } from "./launch-plan.ts";
import type { BrowserDriver } from "./port.ts";

const ABORT_DURING_LAUNCH_MS = 200;

const BASELINE_USE_SWITCH = "--use-mock-keychain";

const LAUNCH_DEADLINE_MS = 500;

const TEARDOWN_SETTLED_WITHIN_MS = 11_500;

const DEAD_PIPE_TEARDOWN_BOUND_MS = 1000;

const isStage = (message: unknown): message is { stage: string; durationMs: number } =>
  typeof message === "object" &&
  message !== null &&
  "stage" in message &&
  typeof message.stage === "string" &&
  "durationMs" in message &&
  typeof message.durationMs === "number";

const launchStages: number[] = [];

const teardownStages: number[] = [];

subscribe("xrio:stage", (message) => {
  if (isStage(message) && message.stage === "launch") {
    launchStages.push(message.durationMs);
  }

  if (isStage(message) && message.stage === "teardown") {
    teardownStages.push(message.durationMs);
  }
});

const isTeardownIncomplete = (
  message: unknown,
): message is { event: "teardown-incomplete"; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "teardown-incomplete" &&
  "detail" in message &&
  typeof message.detail === "string";

const incompleteTeardowns: string[] = [];

subscribe("xrio:event", (message) => {
  if (isTeardownIncomplete(message)) {
    incompleteTeardowns.push(message.detail);
  }
});

const settlesWithinTeardownBudget = async (closing: Promise<void>): Promise<boolean> =>
  await Promise.race([
    (async () => {
      await closing;

      return true;
    })(),
    delay(TEARDOWN_SETTLED_WITHIN_MS, false),
  ]);

const removeLeftoverScratch = async (): Promise<void> => {
  const { directories } = await leftovers();

  await Promise.all(
    directories.map(async (directory) => {
      await rm(path.join(scratchRoot(), directory), { force: true, recursive: true });
    }),
  );
};

const load = async (scenario: string, timeoutMs = 10_000, signal?: AbortSignal) => {
  const browsers = createBrowsers(cdpDriver, 2);
  using deadline = startDeadline(timeoutMs, signal);

  try {
    return await browsers.load({
      browserArgs: [],
      browserPath: await fakeChromePath(scenario),
      deadline,
      mode: "headless",
      pins: noPins,
      proxy: undefined,
      url: new URL("https://fake.test/page"),
    });
  } finally {
    await browsers.close();
  }
};

describe("browser lifecycle on the fake browser", () => {
  it.each(["normal", "fragmented"])("renders over the pipe with %s framing", async (scenario) => {
    const document = await load(scenario);

    expect(document).toMatchObject({
      cookies: ["a=1", "b=2"],
      headers: { "content-type": "text/html; charset=utf-8", "x-fake": "yes" },
      status: 200,
      url: "https://fake.test/page",
    });
    expect(document.html).toContain("fake page");
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reports a launch failure with the end of Chrome's stderr", async () => {
    await expect(load("no-start")).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") &&
        error.details.stderr.includes("fake chrome cannot start"),
    );
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("refuses a Chrome older than the supported range", async () => {
    await expect(load("old")).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") && error.message.includes("older than 150"),
    );
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reports a browser that dies mid-scrape", async () => {
    await expect(load("crash-on-navigate")).rejects.toMatchObject({
      code: "BROWSER_CRASHED",
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("kills a browser whose pipe closed while it kept running, without waiting out the close budget", async () => {
    await expect(load("pipe-closes-on-navigate")).rejects.toMatchObject({
      code: "BROWSER_CRASHED",
    });
    expect(teardownStages.at(-1)).toBeLessThan(DEAD_PIPE_TEARDOWN_BOUND_MS);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reports a navigation error with Chrome's net error", async () => {
    await expect(load("navigate-error")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      details: { netError: "net::ERR_NAME_NOT_RESOLVED" },
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("kills a browser that ignores Browser.close", async () => {
    await expect(load("ignore-close")).resolves.toMatchObject({ status: 200 });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("cleans up after a caller abort during launch", async () => {
    const reason = new Error("Stopped by caller");
    const controller = new AbortController();
    const loading = load("slow-start", 10_000, controller.signal);

    setTimeout(() => {
      controller.abort(reason);
    }, ABORT_DURING_LAUNCH_MS);
    await expect(loading).rejects.toBe(reason);
    await expect(
      load("slow-start", 10_000, AbortSignal.timeout(ABORT_DURING_LAUNCH_MS)),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("rejects with TIMEOUT during launch while teardown is still cleaning up", async () => {
    const cleanups: { settled: boolean }[] = [];

    const observedDriver: BrowserDriver = {
      launch: async (plan, deadline, owned, deferCleanup) =>
        await cdpDriver.launch(plan, deadline, owned, (cleanup) => {
          const observed = { settled: false };

          cleanups.push(observed);
          deferCleanup(
            (async () => {
              await cleanup;
              observed.settled = true;
            })(),
          );
        }),
    };

    const browsers = createBrowsers(observedDriver, 1);
    using deadline = startDeadline(LAUNCH_DEADLINE_MS);

    await expect(
      browsers.load({
        browserArgs: [],
        browserPath: await fakeChromePath("slow-start"),
        deadline,
        mode: "headless",
        pins: noPins,
        proxy: undefined,
        url: new URL("https://fake.test/page"),
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(cleanups).toStrictEqual([{ settled: false }]);
    await browsers.close();
    expect(cleanups).toStrictEqual([{ settled: true }]);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it.each([
    { scenario: "slow-start", stage: "launch" },
    { scenario: "hang-on-navigate", stage: "navigation" },
  ])(
    "rejects with TIMEOUT when the deadline ends a $stage that outlasts it",
    async ({ scenario }) => {
      const { advance, clock } = manualClock();
      const browsers = createBrowsers(cdpDriver, 1);
      using deadline = startDeadline(LAUNCH_DEADLINE_MS, undefined, clock);

      const settled = Promise.allSettled([
        browsers.load({
          browserArgs: [],
          browserPath: await fakeChromePath(scenario),
          deadline,
          mode: "headless",
          pins: noPins,
          proxy: undefined,
          url: new URL("https://fake.test/page"),
        }),
      ]);

      await delay(4 * LAUNCH_DEADLINE_MS);
      advance(LAUNCH_DEADLINE_MS);

      await expect(settled).resolves.toMatchObject([
        { reason: { code: "TIMEOUT" }, status: "rejected" },
      ]);
      await browsers.close();
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    },
  );
});

const queuedRequest = async () => ({
  browserArgs: [],
  browserPath: await fakeChromePath("slow-start"),
  mode: "headless" as const,
  pins: noPins,
  proxy: undefined,
  url: new URL("https://fake.test/"),
});

describe(createBrowsers, () => {
  it("queues past maxBrowsers and counts the wait against the deadline", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    const request = await queuedRequest();
    using held = startDeadline(1500);
    using queued = startDeadline(200);

    const launchesBefore = launchStages.length;

    const first = browsers.load({ ...request, deadline: held });
    const second = browsers.load({ ...request, deadline: queued });

    await expect(second).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(first).rejects.toMatchObject({ code: "TIMEOUT" });
    await browsers.close();
    expect(launchStages.length - launchesBefore).toBe(1);
  });

  it("lets accepted work finish when closed, and rejects new work afterwards", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    const request = await queuedRequest();
    const normal = { ...request, browserPath: await fakeChromePath("normal") };
    using held = startDeadline(1000);
    using queued = startDeadline(10_000);

    const settled: string[] = [];

    const first = browsers.load({ ...request, deadline: held });

    const second = (async () => {
      const document = await browsers.load({ ...normal, deadline: queued });

      settled.push("queued scrape");

      return document;
    })();

    const closing = (async () => {
      await browsers.close();
      settled.push("close");
    })();

    await expect(first).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(second).resolves.toMatchObject({ status: 200 });
    await closing;
    expect(settled).toStrictEqual(["queued scrape", "close"]);
    await expect(browsers.load({ ...normal, deadline: queued })).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

const settledValue = async (promise: Promise<unknown>) => {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
};

interface VisitCase {
  scenario: string;
  timeoutMs?: number;
  abortAfterMs?: number;
}

const visitOn = async (
  driver: BrowserDriver,
  { abortAfterMs, scenario, timeoutMs = 10_000 }: VisitCase,
  steps: Partial<RetireSteps> = {},
) => {
  const browsers = createBrowsers(driver, 1, steps);
  const owner = new AbortController();
  const browserPath = await fakeChromePath(scenario);
  using deadline: Deadline & Disposable = startDeadline(timeoutMs);

  const visit = browsers.start({
    browserArgs: [],
    browserPath,
    deadline: deadline.boundTo(owner.signal),
    mode: "headless",
    pins: noPins,
    proxy: undefined,
    url: new URL("https://fake.test/page"),
  });

  if (abortAfterMs !== undefined) {
    setTimeout(() => {
      owner.abort(new Error("Ownership lost"));
    }, abortAfterMs);
  }

  const document = await settledValue(visit.document);
  const closed = await visit.closed;
  const leftAtClose = await leftovers();

  await browsers.close();

  return { closed, document, leftAtClose };
};

const settledCleanly = { closed: { exited: true }, leftAtClose: nothingLeft };

describe("browser visits on the fake browser", () => {
  it("resolves the document, then closes once Chrome and its profile are gone", async () => {
    await expect(visitOn(cdpDriver, { scenario: "normal" })).resolves.toMatchObject({
      ...settledCleanly,
      document: { value: { status: 200, url: "https://fake.test/page" } },
    });
  });

  it.each([
    { error: { code: "BROWSER_LAUNCH_FAILED" }, scenario: "no-start" },
    { error: { code: "BROWSER_CRASHED" }, scenario: "crash-on-navigate" },
    {
      error: { code: "NETWORK_ERROR", details: { netError: "net::ERR_NAME_NOT_RESOLVED" } },
      scenario: "navigate-error",
    },
    {
      abortAfterMs: ABORT_DURING_LAUNCH_MS,
      error: { message: "Ownership lost" },
      scenario: "slow-start",
    },
    { error: { code: "TIMEOUT" }, scenario: "slow-start", timeoutMs: LAUNCH_DEADLINE_MS },
  ])(
    "rejects the document with $error after $scenario, then closes once nothing is left",
    async ({ error, ...visitCase }) => {
      await expect(visitOn(cdpDriver, visitCase)).resolves.toMatchObject({
        ...settledCleanly,
        document: { error },
      });
    },
  );

  it("removes the visit's scratch directory when planning throws", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(10_000);

    const visit = browsers.start({
      browserArgs: [],
      get browserPath(): string {
        throw new Error("Planning failed.");
      },
      deadline,
      mode: "headless",
      pins: noPins,
      proxy: undefined,
      url: new URL("https://fake.test/page"),
    });

    const document = await settledValue(visit.document);
    const closed = await visit.closed;
    const leftAtClose = await leftovers();

    await browsers.close();
    expect({ closed, document, leftAtClose }).toMatchObject({
      closed: { exited: true },
      document: { error: { message: "Planning failed." } },
      leftAtClose: nothingLeft,
    });
  });

  it("closes with exited false and a reason when teardown cannot confirm that Chrome exited", async () => {
    const outcome = await visitOn(
      cdpDriver,
      { scenario: "normal" },
      {
        retireProcessGroup: async (pgid) => {
          killProcessGroup(pgid);
          await waitForGroupExit(pgid, AbortSignal.timeout(5000));

          return false;
        },
      },
    );

    const [directory = ""] = outcome.leftAtClose.directories;
    const scratch = path.join(scratchRoot(), directory);

    await rm(scratch, { force: true, recursive: true });

    expect(outcome.document).toMatchObject({ value: { status: 200 } });
    expect(outcome.closed).toStrictEqual({
      exited: false,
      reason: `Chrome outlived its teardown; ${scratch} is left for the sweep.`,
    });
    expect(outcome.leftAtClose).toStrictEqual({ directories: [directory], processes: [] });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

type PlanningOverrides = NonNullable<Parameters<typeof createBrowsers>[2]>;

const loadTwice = async (steps: PlanningOverrides, firstScenario: string) => {
  const browsers = createBrowsers(cdpDriver, 1, steps);
  using deadline = startDeadline(10_000);

  const request = {
    browserArgs: [],
    deadline,
    mode: "headless" as const,
    pins: noPins,
    proxy: undefined,
    url: new URL("https://fake.test/page"),
  };

  const first = await settledValue(
    browsers.load({ ...request, browserPath: await fakeChromePath(firstScenario) }),
  );

  const second = await settledValue(
    browsers.load({ ...request, browserPath: await fakeChromePath("normal") }),
  );

  await browsers.close();

  return { first, left: await leftovers(), second };
};

describe("planning between admission and start", () => {
  it("releases admission when a planning step throws before start", async () => {
    let plans = 0;

    const failFirstPlan = () => {
      plans += 1;

      if (plans === 1) {
        throw new Error("The session step failed.");
      }

      return sessionFor();
    };

    await expect(loadTwice({ sessionFor: failFirstPlan }, "normal")).resolves.toMatchObject({
      first: { error: { message: "The session step failed." } },
      left: nothingLeft,
      second: { value: { status: 200 } },
    });
  });

  it("releases admission when the identity step throws before start", async () => {
    let plans = 0;

    const failFirstIdentity: typeof planIdentity = (context) => {
      plans += 1;

      if (plans === 1) {
        throw new Error("The identity step failed.");
      }

      return planIdentity(context);
    };

    await expect(loadTwice({ planIdentity: failFirstIdentity }, "normal")).resolves.toMatchObject({
      first: { error: { message: "The identity step failed." } },
      left: nothingLeft,
      second: { value: { status: 200 } },
    });
  });

  it("stops a visit when its session's ownership aborts, then admits the next scrape", async () => {
    let plans = 0;

    const loseFirstOwnership = () => {
      plans += 1;

      return plans === 1
        ? {
            kind: "anonymous" as const,
            ownership: { signal: AbortSignal.timeout(ABORT_DURING_LAUNCH_MS) },
          }
        : sessionFor();
    };

    await expect(
      loadTwice({ sessionFor: loseFirstOwnership }, "slow-start"),
    ).resolves.toMatchObject({
      first: { error: { name: "TimeoutError" } },
      left: nothingLeft,
      second: { value: { status: 200 } },
    });
  });
});

const normalRequest = async (deadline: Deadline) => ({
  browserArgs: [],
  browserPath: await fakeChromePath("normal"),
  deadline,
  mode: "headless" as const,
  pins: noPins,
  proxy: undefined,
  url: new URL("https://fake.test/page"),
});

describe("bounded teardown on the fake browser", () => {
  it("kills the owned browser when Browser.close fails", async () => {
    const pids: number[] = [];

    const failedCloseDriver: BrowserDriver = {
      launch: async (plan, deadline, owned, deferCleanup) => {
        const browser = await cdpDriver.launch(
          plan,
          deadline,
          (pid) => {
            if (pid !== undefined) {
              pids.push(pid);
            }

            owned(pid);
          },
          deferCleanup,
        );

        return {
          ...browser,
          close: async () => {
            await nextTurn();
            throw new Error("Browser.close went unanswered");
          },
        };
      },
    };

    const browsers = createBrowsers(failedCloseDriver, 1);

    using deadline = startDeadline(10_000);

    try {
      await expect(
        browsers.load({
          ...(await normalRequest(deadline)),
          browserPath: await fakeChromePath("ignore-close"),
        }),
      ).resolves.toMatchObject({ status: 200 });
      await browsers.close();
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    } finally {
      for (const pid of pids) {
        killProcessGroup(pid);
      }

      await browsers.close();
    }
  });

  it("kills the owned browser after a deferred launch cleanup hangs and admits queued work", async () => {
    const hangingCleanup = Promise.withResolvers<"released">();
    let launches = 0;

    const failedLaunchDriver: BrowserDriver = {
      launch: async (plan, deadline, owned, deferCleanup) => {
        const browser = await cdpDriver.launch(plan, deadline, owned, deferCleanup);

        launches += 1;

        if (launches === 1) {
          deferCleanup(
            (async () => {
              await hangingCleanup.promise;
            })(),
          );
          throw new Error("The launch failed after Chrome started");
        }

        return browser;
      },
    };

    const browsers = createBrowsers(failedLaunchDriver, 1);

    using deadline = startDeadline(10_000);
    const request = await normalRequest(deadline);

    const first = browsers.load({
      ...request,
      browserPath: await fakeChromePath("ignore-close"),
    });

    const second = browsers.load(request);

    try {
      await expect(first).rejects.toMatchObject({ code: "BROWSER_LAUNCH_FAILED" });
      await expect(second).resolves.toMatchObject({ status: 200 });
      await browsers.close();
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    } finally {
      hangingCleanup.resolve("released");
      await browsers.close();
    }
  });

  it("retains an unknown browser after its launch cleanup hangs while admitting queued work", async () => {
    const hangingCleanup = Promise.withResolvers<"released">();
    const launched: { pid: number; scratch: string }[] = [];
    const reported = incompleteTeardowns.length;

    const failedLaunchDriver: BrowserDriver = {
      launch: async (plan, deadline, owned, deferCleanup) => {
        let pid: number | undefined;

        const browser = await cdpDriver.launch(
          plan,
          deadline,
          (started) => {
            pid = started;

            if (launched.length > 0) {
              owned(started);
            }
          },
          deferCleanup,
        );

        if (pid === undefined) {
          throw new Error("The driver did not report Chrome's process");
        }

        launched.push({ pid, scratch: path.dirname(plan.directories.profile) });

        if (launched.length === 1) {
          deferCleanup(
            (async () => {
              await hangingCleanup.promise;
            })(),
          );
        }

        return browser;
      },
    };

    const browsers = createBrowsers(failedLaunchDriver, 1);
    using deadline = startDeadline(15_000);
    const request = await normalRequest(deadline);

    const first = browsers.load({
      ...request,
      browserPath: await fakeChromePath("ignore-close"),
    });

    const second = browsers.load(request);

    try {
      await expect(first).rejects.toMatchObject({ code: "BROWSER_LAUNCH_FAILED" });
      await expect(second).resolves.toMatchObject({ status: 200 });
      await browsers.close();
      const [unconfirmed] = launched;

      if (unconfirmed === undefined) {
        throw new Error("The failed launch did not start Chrome");
      }

      expect(incompleteTeardowns.slice(reported)).toStrictEqual([
        `Chrome's process group is unknown; ${unconfirmed.scratch} is left for the sweep.`,
      ]);
      await expect(leftovers()).resolves.toMatchObject({
        directories: [path.basename(unconfirmed.scratch)],
      });
    } finally {
      hangingCleanup.resolve("released");

      for (const browser of launched) {
        killProcessGroup(browser.pid);
      }

      await Promise.all(
        launched.map(async ({ pid }) => await waitForGroupExit(pid, AbortSignal.timeout(5000))),
      );
      await browsers.close();
      await Promise.all(
        launched.map(async ({ scratch }) => {
          await rm(scratch, { force: true, recursive: true });
        }),
      );
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  }, 20_000);

  it("kills Chrome and admits queued work after browser.close hangs", async () => {
    const hangingClose = Promise.withResolvers<"released">();
    let launches = 0;

    const hungCloseDriver: BrowserDriver = {
      launch: async (plan, deadline, owned, deferCleanup) => {
        const browser = await cdpDriver.launch(plan, deadline, owned, deferCleanup);

        launches += 1;

        return launches === 1
          ? {
              ...browser,
              close: async () => {
                await hangingClose.promise;
              },
            }
          : browser;
      },
    };

    const browsers = createBrowsers(hungCloseDriver, 1);
    using deadline = startDeadline(10_000);
    const request = await normalRequest(deadline);

    const first = browsers.load({
      ...request,
      browserPath: await fakeChromePath("ignore-close"),
    });

    const second = browsers.load(request);

    try {
      await expect(first).resolves.toMatchObject({ status: 200 });
      await expect(second).resolves.toMatchObject({ status: 200 });
      await browsers.close();
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    } finally {
      hangingClose.resolve("released");
      await browsers.close();
    }
  });

  it("settles within the overall teardown budget when exit confirmation hangs", async () => {
    const hangingExit = Promise.withResolvers<boolean>();
    const reported = incompleteTeardowns.length;

    const browsers = createBrowsers(cdpDriver, 1, {
      retireProcessGroup: async () => await hangingExit.promise,
    });

    using deadline = startDeadline(20_000);

    try {
      await expect(browsers.load(await normalRequest(deadline))).resolves.toMatchObject({
        status: 200,
      });
      await expect(settlesWithinTeardownBudget(browsers.close())).resolves.toBeTruthy();

      const left = await leftovers();
      const [reason = ""] = incompleteTeardowns.slice(reported);

      expect(reason).toContain("Teardown of");
      expect(left.processes).toStrictEqual([]);
      expect(left.directories).toHaveLength(1);
    } finally {
      hangingExit.resolve(true);
      await browsers.close();
      await removeLeftoverScratch();
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  }, 15_000);

  it("retains the scratch directory when its removal hangs past the overall teardown budget", async () => {
    const hangingRemoval = Promise.withResolvers<"released">();
    const removals: { directory: string; signal: AbortSignal | undefined }[] = [];
    const reported = incompleteTeardowns.length;

    const browsers = createBrowsers(cdpDriver, 1, {
      removeScratchDir: async (scratch, signal) => {
        removals.push({ directory: scratch.path, signal });
        await hangingRemoval.promise;
      },
    });

    using deadline = startDeadline(20_000);

    try {
      await expect(browsers.load(await normalRequest(deadline))).resolves.toMatchObject({
        status: 200,
      });
      await expect(settlesWithinTeardownBudget(browsers.close())).resolves.toBeTruthy();

      const [reason = ""] = incompleteTeardowns.slice(reported);

      expect(reason).toContain("Teardown of");
      expect(removals.map(({ signal }) => signal?.aborted)).toStrictEqual([true]);
      const [removal] = removals;

      if (removal === undefined) {
        throw new Error("Teardown did not reach scratch removal");
      }

      await expect(leftovers()).resolves.toStrictEqual({
        directories: [path.basename(removal.directory)],
        processes: [],
      });
    } finally {
      hangingRemoval.resolve("released");
      await browsers.close();
      await removeLeftoverScratch();
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  }, 15_000);
});

describe("process ownership reported by the driver", () => {
  it("refuses a driver that resolves without reporting Chrome's process, and keeps its scratch", async () => {
    let closes = 0;

    const silentDriver: BrowserDriver = {
      launch: async () => {
        await nextTurn();

        return {
          close: async () => {
            closes += 1;
            await nextTurn();
          },
          evaluateIsolated: async () => {
            await nextTurn();
            throw new Error("unused");
          },
          navigate: async () => {
            await nextTurn();
          },
          onEvent: () => () => {},
          product: { headless: true, major: 154, version: "154.0.8037.57" },
        };
      },
    };

    const browsers = createBrowsers(silentDriver, 1);
    using deadline = startDeadline(10_000);

    try {
      await expect(browsers.load(await normalRequest(deadline))).rejects.toSatisfy(
        (error) =>
          isXrioError(error, "BROWSER_LAUNCH_FAILED") &&
          error.message.includes("without reporting process ownership"),
      );
      await browsers.close();
      expect(closes).toBe(1);

      const left = await leftovers();

      expect(left.processes).toStrictEqual([]);
      expect(left.directories).toHaveLength(1);
    } finally {
      await browsers.close();
      await removeLeftoverScratch();
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

describe("visits started directly with start", () => {
  it("returns the visit while its launch is still held", async () => {
    const launchEntered = Promise.withResolvers<"entered">();
    const launchReleased = Promise.withResolvers<"released">();

    const heldDriver: BrowserDriver = {
      launch: async (plan, deadline, owned, deferCleanup) => {
        launchEntered.resolve("entered");
        await launchReleased.promise;

        return await cdpDriver.launch(plan, deadline, owned, deferCleanup);
      },
    };

    const browsers = createBrowsers(heldDriver, 1);
    using deadline = startDeadline(10_000);
    const visit = browsers.start(await normalRequest(deadline));

    await launchEntered.promise;

    const whileHeld = await Promise.race([
      settledValue(visit.document),
      Promise.resolve("pending"),
    ]);

    launchReleased.resolve("released");

    expect(whileHeld).toBe("pending");
    await expect(visit.document).resolves.toMatchObject({ status: 200 });
    await expect(visit.closed).resolves.toStrictEqual({ exited: true });
    await browsers.close();
  });

  it("lets a caller await closed before it handles a rejected document", async () => {
    let unhandled = 0;

    const recordUnhandled = () => {
      unhandled += 1;
    };

    process.on("unhandledRejection", recordUnhandled);

    try {
      const browsers = createBrowsers(cdpDriver, 1);
      using deadline = startDeadline(10_000);

      const visit = browsers.start({
        ...(await normalRequest(deadline)),
        browserPath: await fakeChromePath("no-start"),
      });

      await expect(visit.closed).resolves.toStrictEqual({ exited: true });
      await nextTurn();
      await expect(visit.document).rejects.toMatchObject({ code: "BROWSER_LAUNCH_FAILED" });
      await browsers.close();
    } finally {
      process.off("unhandledRejection", recordUnhandled);
    }

    expect(unhandled).toBe(0);
  });

  it("makes close wait for the visit to close", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(10_000);
    const visit = browsers.start(await normalRequest(deadline));
    const order: string[] = [];

    await Promise.all([
      settledValue(visit.document),
      (async () => {
        await visit.closed;
        order.push("visit closed");
      })(),
      (async () => {
        await browsers.close();
        order.push("browsers closed");
      })(),
    ]);

    expect(order).toStrictEqual(["visit closed", "browsers closed"]);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("refuses a visit after close with CLIENT_CLOSED and launches nothing", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(10_000);
    using stages = stageTimeline(new Set(["queue", "launch"]));

    await browsers.close();

    const visit = stages.recording(async () => browsers.start(await normalRequest(deadline)));
    const { closed, document } = await visit;

    await expect(document).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(closed).resolves.toStrictEqual({ exited: true });
    expect(stages.timeline).toStrictEqual([]);
  });

  it("queues a load behind a started visit on maxBrowsers 1", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(20_000);
    using stages = stageTimeline(new Set(["launch", "teardown"]));
    const request = await normalRequest(deadline);

    await stages.recording(async () => {
      const visit = browsers.start(request);

      await Promise.all([visit.document, visit.closed, browsers.load(request)]);
    });
    await browsers.close();

    expect(stages.timeline).toStrictEqual(["launch", "teardown", "launch", "teardown"]);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

const launchPlanOf = async (
  steps: PlanningOverrides,
  mode: "headless" | "headed" = "headless",
  browserArgs: readonly string[] = [],
  timezone?: string,
): Promise<LaunchPlan | undefined> => {
  const launched: LaunchPlan[] = [];

  const recordingDriver: BrowserDriver = {
    launch: async (plan, deadline, owned, deferCleanup) => {
      launched.push(plan);

      return await cdpDriver.launch(plan, deadline, owned, deferCleanup);
    },
  };

  const browsers = createBrowsers(recordingDriver, 1, steps);
  using deadline = startDeadline(10_000);

  await browsers.load({
    ...(await normalRequest(deadline)),
    browserArgs,
    mode,
    pins: { ...noPins, timezone },
  });
  await browsers.close();

  return launched[0];
};

const changeHostAfterSession: typeof sessionFor = () => {
  void (async () => {
    await nextTurn();
    vi.stubEnv("TZ", "Europe/Berlin");
    vi.stubEnv("DISPLAY", ":2");
    vi.stubEnv("XAUTHORITY", "/tmp/second.Xauthority");
  })();

  return sessionFor();
};

describe("the identity a visit launches Chrome with", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("launches Chrome with the client's switches once, after Xrio's own", async () => {
    const plan = await launchPlanOf({}, "headless", ["--no-sandbox"]);

    expect(plan?.args.filter((arg) => arg === "--no-sandbox")).toStrictEqual(["--no-sandbox"]);
    expect(plan?.args.slice(-4)).toStrictEqual([
      "--no-sandbox",
      `--user-data-dir=${plan?.directories.profile}`,
      "--remote-debugging-pipe",
      "about:blank",
    ]);
  });

  it.each([
    ["Asia/Kolkata", "Asia/Calcutta"],
    ["America/Chicago", "America/Chicago"],
    [":UTC", "UTC"],
    ["posix/Europe/Berlin", "Europe/Berlin"],
    ["", "UTC"],
    ["garbage", "UTC"],
    ["europe/berlin", "UTC"],
  ])(
    "launches Chrome with TZ set to the zone of the host's TZ=%j, which is %s",
    async (ambient, zone) => {
      vi.stubEnv("TZ", ambient);

      await expect(launchPlanOf({})).resolves.toMatchObject({ env: { TZ: zone } });
    },
  );

  it("launches Chrome with a pinned zone instead of the host's", async () => {
    vi.stubEnv("TZ", "Asia/Kolkata");

    await expect(launchPlanOf({}, "headless", [], "America/New_York")).resolves.toMatchObject({
      env: { TZ: "America/New_York" },
    });
  });

  it("launches Chrome with a TZ of its own when the host exports none", async () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    delete process.env.TZ;

    const plan = await launchPlanOf({});

    expect(plan?.env.TZ).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("reads the host's zone, display and Xauthority together, after the scratch is created and before planning", async () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    vi.stubEnv("DISPLAY", ":1");
    vi.stubEnv("XAUTHORITY", "/tmp/first.Xauthority");

    const scratchWhenPlanning: number[] = [];

    const changeHostMidPlan: typeof planIdentity = (context) => {
      scratchWhenPlanning.push(ownedScratchDirs().length);
      vi.stubEnv("TZ", "UTC");
      vi.stubEnv("DISPLAY", ":3");
      vi.stubEnv("XAUTHORITY", "/tmp/third.Xauthority");

      return planIdentity(context);
    };

    const plan = await launchPlanOf(
      { planIdentity: changeHostMidPlan, sessionFor: changeHostAfterSession },
      "headed",
    );

    expect({ env: plan?.env, scratchWhenPlanning }).toMatchObject({
      env: { DISPLAY: ":2", TZ: "Europe/Berlin", XAUTHORITY: "/tmp/second.Xauthority" },
      scratchWhenPlanning: [1],
    });
  });

  it.each([
    {
      platform: "linux" as const,
      switches: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--use-fake-device-for-media-stream=device-count=0",
      ],
    },
    { platform: "darwin" as const, switches: [] },
  ])(
    "selects the GL backend and the media devices from the host's $platform capabilities",
    async ({ platform, switches }) => {
      const plan = await launchPlanOf({ hostCapabilities: () => ({ platform }) });

      expect(
        plan?.args.filter((value) => value.startsWith("--use-") && value !== BASELINE_USE_SWITCH),
      ).toStrictEqual(switches);
    },
  );
});

const readingWith = (read: (deadline: Deadline) => Promise<string>): BrowserDriver => ({
  launch: async (plan, deadline, owned, deferCleanup) => {
    const browser = await cdpDriver.launch(plan, deadline, owned, deferCleanup);

    return {
      ...browser,
      evaluateIsolated: async (_expression, isResult, readDeadline) => {
        const value = await read(readDeadline);

        if (!isResult(value)) {
          throw new Error("The test read returned an unexpected value.");
        }

        return value;
      },
    };
  },
});

const FAKE_PRODUCT = { headless: true, major: 154, version: "154.0.8037.57" } as const;

describe("the launch identity check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runs as the verify stage after launch and before navigation", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(10_000);

    using stages = stageTimeline(
      new Set(["launch", "verify", "navigation", "capture", "teardown"]),
    );

    await stages.recording(async () => await browsers.load(await normalRequest(deadline)));
    await browsers.close();
    expect(stages.timeline).toStrictEqual([
      "launch",
      "verify",
      "navigation",
      "capture",
      "teardown",
    ]);
  });

  it("resolves the document with the report of what the launch read", async () => {
    vi.stubEnv("TZ", "UTC");

    const browsers = createBrowsers(cdpDriver, 1, {
      hostCapabilities: () => ({ platform: "linux" }),
    });

    using deadline = startDeadline(10_000);
    const document = await browsers.load(await normalRequest(deadline));

    await browsers.close();
    expect(document.identity).toMatchObject({
      binary: { version: "154.0.8037.57" },
      coverage: {
        deviceMemory: { state: "observed" },
        screen: { state: "observed" },
        timezone: { state: "observed" },
      },
      exit: { facts: { kind: "unknown" }, route: "direct" },
      mode: "headless",
      notes: [],
      observed: {
        deviceMemory: 8,
        offsets: ["GMT+00:00", "GMT+00:00"],
        screen: { availHeight: 1040, height: 1080, width: 1920 },
        timeZone: "UTC",
        window: { outerHeight: 900, outerWidth: 1600 },
      },
      surfaces: { timezone: { source: "host", zone: "UTC" } },
      tells: ["headless-token", "host-zone-utc"],
    });
  });

  it("reports a pinned UTC as the caller's choice, not as the host's", async () => {
    vi.stubEnv("TZ", "UTC");

    const browsers = createBrowsers(cdpDriver, 1, {
      hostCapabilities: () => ({ platform: "linux" }),
    });

    using deadline = startDeadline(10_000);

    const document = await browsers.load({
      ...(await normalRequest(deadline)),
      pins: { ...noPins, timezone: "UTC" },
    });

    await browsers.close();
    expect(document.identity).toMatchObject({
      surfaces: { timezone: { source: "pin", zone: "UTC" } },
      tells: ["headless-token"],
    });
  });

  it("rejects a drifted zone before navigation, names it, and still tears Chrome down", async () => {
    vi.stubEnv("TZ", "America/Chicago");

    const observed: Observation[] = [];

    const recordingEvaluate: typeof evaluate = (expected, observation) => {
      observed.push(observation);

      return evaluate(expected, observation);
    };

    const browsers = createBrowsers(cdpDriver, 1, { evaluate: recordingEvaluate });
    using deadline = startDeadline(10_000);

    using stages = stageTimeline(
      new Set(["launch", "verify", "navigation", "capture", "teardown"]),
    );

    const visit = stages.recording(async () =>
      browsers.start({
        ...(await normalRequest(deadline)),
        browserPath: await fakeChromePath("identity-drift"),
      }),
    );

    const { closed: closing, document: rendering } = await visit;
    const document = await settledValue(rendering);
    const closed = await closing;
    const leftAtClose = await leftovers();

    await browsers.close();
    expect({ closed, document, leftAtClose, observed, timeline: stages.timeline }).toMatchObject({
      closed: { exited: true },
      document: {
        error: {
          code: "BROWSER_LAUNCH_FAILED",
          details: {
            mismatches: [
              {
                expected: ["GMT-06:00", "GMT-05:00"],
                field: "zoneOffsets",
                observed: ["GMT+00:00", "GMT+00:00"],
                surface: "timezone",
              },
            ],
            stderr: "",
          },
          message:
            "Chrome's launch identity does not match Xrio's plan: timezone zoneOffsets (TZ=America/Chicago).",
        },
      },
      leftAtClose: nothingLeft,
      observed: [
        {
          product: FAKE_PRODUCT,
          requestedOffsets: ["GMT-06:00", "GMT-05:00"],
          zone: "UTC",
          zoneOffsets: ["GMT+00:00", "GMT+00:00"],
        },
      ],
      timeline: ["launch", "verify", "teardown"],
    });
  });

  it("rejects a Chrome that ignores the pinned locale before navigation", async () => {
    const browsers = createBrowsers(cdpDriver, 1, {
      hostCapabilities: () => ({ platform: "linux" }),
    });

    using deadline = startDeadline(10_000);

    using stages = stageTimeline(
      new Set(["launch", "verify", "navigation", "capture", "teardown"]),
    );

    const document = await stages.recording(
      async () =>
        await settledValue(
          browsers.load({
            ...(await normalRequest(deadline)),
            pins: { locale: "de-DE", timezone: undefined },
          }),
        ),
    );

    await browsers.close();
    expect({ document, timeline: stages.timeline }).toMatchObject({
      document: {
        error: {
          code: "BROWSER_LAUNCH_FAILED",
          details: {
            mismatches: [
              {
                expected: ["de-DE", "de", "en-US", "en"],
                field: "languages",
                observed: ["en-US", "en"],
                surface: "locale",
              },
              { expected: "de", field: "intlLocale", observed: "en-US", surface: "locale" },
            ],
          },
        },
      },
      timeline: ["launch", "verify", "teardown"],
    });
  });

  it("reads again once when Chrome reports an unsized window, then evaluates the sized one", async () => {
    const observed: { outerWidth: number; outerHeight: number }[] = [];

    const recordingEvaluate: typeof evaluate = (expected, observation) => {
      if (observation.afterCapture.kind === "not-navigated") {
        observed.push({ outerHeight: observation.outerHeight, outerWidth: observation.outerWidth });
      }

      return evaluate(expected, observation);
    };

    const browsers = createBrowsers(cdpDriver, 1, { evaluate: recordingEvaluate });
    using deadline = startDeadline(10_000);

    const document = await settledValue(
      browsers.load({
        ...(await normalRequest(deadline)),
        browserPath: await fakeChromePath("unsized-window"),
      }),
    );

    await browsers.close();
    expect({ document, observed }).toMatchObject({
      document: { value: { status: 200 } },
      observed: [{ outerHeight: 900, outerWidth: 1600 }],
    });
  });

  it.each([
    {
      failure: "a malformed read",
      message:
        "Xrio could not read Chrome's launch identity: The identity read returned a malformed anyPointer",
      read: async () => await Promise.resolve("{}"),
    },
    {
      failure: "a read that is not JSON",
      message: "Xrio could not read Chrome's launch identity: Unexpected token",
      read: async () => await Promise.resolve("<html>"),
    },
    {
      failure: "a read that throws",
      message: "Xrio could not read Chrome's launch identity: Read failed.",
      read: async () => await Promise.reject(new Error("Read failed.")),
    },
  ])("rejects $failure with BROWSER_LAUNCH_FAILED and no mismatches", async ({ message, read }) => {
    const outcome = await visitOn(readingWith(read), { scenario: "normal" });

    expect(outcome).toMatchObject({
      ...settledCleanly,
      document: {
        error: { code: "BROWSER_LAUNCH_FAILED", details: { mismatches: [], stderr: "" } },
      },
    });
    expect(outcome.document).toSatisfy(
      ({ error }) => error instanceof Error && error.message.startsWith(message),
    );
  });

  it.each([
    {
      deadlineMs: 60_000,
      error: {
        code: "BROWSER_LAUNCH_FAILED",
        details: { mismatches: [] },
        message:
          "Xrio could not read Chrome's launch identity: The stage did not finish within 10000 ms.",
      },
      waitMs: 10_000,
    },
    { deadlineMs: 5000, error: { code: "TIMEOUT" }, waitMs: 5000 },
  ])(
    "rejects a read still running after $waitMs ms of a $deadlineMs ms deadline with $error.code",
    async ({ deadlineMs, error, waitMs }) => {
      const { advance, clock } = manualClock();
      const readStarted = Promise.withResolvers<"started">();

      const hangingRead = readingWith(async (deadline) => {
        readStarted.resolve("started");

        return await untilDeadline(
          async () => await Promise.withResolvers<string>().promise,
          deadline,
        );
      });

      const browsers = createBrowsers(hangingRead, 1);
      using deadline = startDeadline(deadlineMs, undefined, clock);
      const visit = browsers.start(await normalRequest(deadline));

      await readStarted.promise;
      advance(waitMs);

      const document = await settledValue(visit.document);
      const closed = await visit.closed;

      await browsers.close();
      expect({ closed, document }).toMatchObject({ closed: { exited: true }, document: { error } });
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    },
  );
});

const isEvent = (message: unknown): message is { event: string; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  typeof message.event === "string" &&
  "detail" in message &&
  typeof message.detail === "string";

describe("the identity-chosen event", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { outcome: { value: { status: 200 } }, scenario: "normal" },
    { outcome: { error: { code: "BROWSER_CRASHED" } }, scenario: "crash-on-navigate" },
  ])(
    "names the chosen identity before Chrome launches on a $scenario visit",
    async ({ outcome, scenario }) => {
      vi.stubEnv("TZ", "UTC");

      const events: { event: string; detail: string }[] = [];

      const record: ChannelListener = (message) => {
        if (isEvent(message)) {
          events.push(message);
        }
      };

      const browsers = createBrowsers(cdpDriver, 1, {
        hostCapabilities: () => ({ platform: "linux" }),
      });

      using deadline = startDeadline(10_000);
      subscribe("xrio:event", record);

      const document = await settledValue(
        browsers
          .load({ ...(await normalRequest(deadline)), browserPath: await fakeChromePath(scenario) })
          .finally(() => {
            unsubscribe("xrio:event", record);
          }),
      );

      await browsers.close();

      const chosen: unknown = JSON.parse(
        events.find(({ event }) => event === "identity-chosen")?.detail ?? "null",
      );

      expect({
        chosen,
        document,
        order: events.flatMap(({ event }) =>
          event === "identity-chosen" || event === "browser-launched" ? [event] : [],
        ),
      }).toMatchObject({
        chosen: {
          exit: { facts: { kind: "unknown" }, route: "direct" },
          mode: "headless",
          surfaces: {
            automation: null,
            gpu: { backend: "swiftshader", persona: null },
            leaks: { dnsOverHttps: "off", networkPrediction: "off" },
            locale: { languages: ["en-US", "en"], tag: "en-US" },
            media: { devices: { audioinput: 1, audiooutput: 1, videoinput: 0 }, source: "fake" },
            screen: {
              size: { height: 1080, width: 1920 },
              source: "fixed",
              workArea: { bottom: 40, left: 0, right: 0, top: 0 },
            },
            timezone: { source: "host", zone: "UTC" },
            window: { size: { height: 900, width: 1600 }, source: "fixed" },
          },
        },
        document: outcome,
        order: ["identity-chosen", "browser-launched"],
      });
    },
  );
});

const readingAfterCaptureWith = (read: (deadline: Deadline) => Promise<string>): BrowserDriver => ({
  launch: async (plan, deadline, owned, deferCleanup) => {
    const browser = await cdpDriver.launch(plan, deadline, owned, deferCleanup);

    return {
      ...browser,
      evaluateIsolated: async (expression, isResult, readDeadline) => {
        if (expression !== AFTER_CAPTURE_READ) {
          return await browser.evaluateIsolated(expression, isResult, readDeadline);
        }

        const value = await read(readDeadline);

        if (!isResult(value)) {
          throw new Error("The test read returned an unexpected value.");
        }

        return value;
      },
    };
  },
});

const SECURE_READING = JSON.stringify({
  battery: true,
  clientHints: {
    architecture: "x86",
    bitness: "64",
    brands: null,
    fullVersionList: null,
    mobile: false,
    model: "",
    platform: "Linux",
    platformVersion: "6.8.0",
    wow64: false,
  },
  deviceMemory: 8,
  kind: "secure",
  webgpu: false,
});

const secureContextUnchecked = (reason: string) => ({
  battery: { reason, state: "unchecked" },
  clientHints: { reason, state: "unchecked" },
  deviceMemory: { reason, state: "unchecked" },
  webgpu: { reason, state: "unchecked" },
});

describe("the after-capture read", () => {
  it("runs inside the capture stage and fills the report's secure-context surfaces", async () => {
    using stages = stageTimeline(new Set(["verify", "navigation", "capture", "teardown"]));

    const browsers = createBrowsers(
      readingAfterCaptureWith(async () => {
        stages.mark("read");

        return await Promise.resolve(SECURE_READING);
      }),
      1,
    );

    using deadline = startDeadline(10_000);

    const document = await stages.recording(
      async () => await browsers.load(await normalRequest(deadline)),
    );

    await browsers.close();
    expect({ identity: document.identity, timeline: stages.timeline }).toMatchObject({
      identity: {
        coverage: { battery: { state: "observed" }, clientHints: { state: "observed" } },
        observed: { clientHints: { architecture: "x86", bitness: "64" } },
      },
      timeline: ["verify", "navigation", "read", "capture", "teardown"],
    });
  });

  it.each([
    { coverage: { state: "observed" }, leftMs: 100, reads: 1 },
    { coverage: { reason: "no-time", state: "unchecked" }, leftMs: 99, reads: 0 },
    { coverage: { reason: "no-time", state: "unchecked" }, leftMs: 40, reads: 0 },
  ])(
    "leaves $reads reads with $leftMs ms of the deadline remaining, and keeps the document",
    async ({ coverage, leftMs, reads }) => {
      const { advance, clock } = manualClock();
      let isolatedCalls = 0;
      let afterCaptureReads = 0;

      const nearlyExpired: BrowserDriver = {
        launch: async (plan, launchDeadline, owned, deferCleanup) => {
          const browser = await cdpDriver.launch(plan, launchDeadline, owned, deferCleanup);

          return {
            ...browser,
            evaluateIsolated: async (expression, isResult, readDeadline) => {
              afterCaptureReads += expression === AFTER_CAPTURE_READ ? 1 : 0;

              const value = await browser.evaluateIsolated(expression, isResult, readDeadline);

              isolatedCalls += 1;

              if (isolatedCalls === 2) {
                advance(10_000 - leftMs);
              }

              return value;
            },
          };
        },
      };

      const browsers = createBrowsers(nearlyExpired, 1);
      using deadline = startDeadline(10_000, undefined, clock);
      const visit = browsers.start(await normalRequest(deadline));
      const document = await settledValue(visit.document);
      const closed = await visit.closed;

      await browsers.close();
      expect({ afterCaptureReads, closed, document }).toMatchObject({
        afterCaptureReads: reads,
        closed: { exited: true },
        document: {
          value: { identity: { coverage: { deviceMemory: coverage } }, status: 200 },
        },
      });
    },
  );

  it.each([
    { failure: "a malformed reading", read: async () => await Promise.resolve("{}") },
    { failure: "a reading that is not JSON", read: async () => await Promise.resolve("<html>") },
    {
      failure: "a read that throws",
      read: async () => await Promise.reject(new Error("Read failed.")),
    },
  ])("keeps the document and reports read-failed on $failure", async ({ read }) => {
    const outcome = await visitOn(readingAfterCaptureWith(read), { scenario: "normal" });

    expect(outcome).toMatchObject({
      ...settledCleanly,
      document: {
        value: {
          html: "<!DOCTYPE html><html><head></head><body><p>fake page</p></body></html>",
          identity: { coverage: secureContextUnchecked("read-failed") },
          status: 200,
        },
      },
    });
  });

  it.each([
    { deadlineMs: 60_000, waitMs: 250 },
    { deadlineMs: 400, waitMs: 200 },
  ])(
    "gives up on a read still running after $waitMs ms of a $deadlineMs ms deadline and keeps the document",
    async ({ deadlineMs, waitMs }) => {
      const { advance, clock } = manualClock();
      const readStarted = Promise.withResolvers<"started">();

      const hangingRead = readingAfterCaptureWith(async (deadline) => {
        readStarted.resolve("started");

        return await untilDeadline(
          async () => await Promise.withResolvers<string>().promise,
          deadline,
        );
      });

      const browsers = createBrowsers(hangingRead, 1);
      using deadline = startDeadline(deadlineMs, undefined, clock);
      const visit = browsers.start(await normalRequest(deadline));

      await readStarted.promise;
      advance(waitMs - 1);
      await nextTurn();

      const early = await Promise.race([visit.document.then(() => "settled"), nextTurn("pending")]);

      advance(1);

      const document = await settledValue(visit.document);
      const closed = await visit.closed;

      await browsers.close();
      expect({ closed, document, early }).toMatchObject({
        closed: { exited: true },
        document: {
          value: { identity: { coverage: secureContextUnchecked("read-failed") }, status: 200 },
        },
        early: "pending",
      });
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    },
  );
});
