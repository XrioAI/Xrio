import { randomUUID } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import { startDeadline, untilDeadline } from "./deadline.ts";
import type { Deadline } from "./deadline.ts";
import { isXrioError } from "./errors.ts";
import type { HostCapabilities } from "./humanizer/contracts.ts";
import { AFTER_CAPTURE_READ } from "./humanizer/verify.ts";
import { HeldDeadline } from "./lifetime.ts";
import { anonymousSessions } from "./sessions/session.ts";
import type { SessionManager } from "./sessions/session.ts";
import { scratchRoot } from "./sources/browser/browser-process.ts";
import { createCapabilityProbe } from "./sources/browser/capabilities.ts";
import { cdpDriver } from "./sources/browser/cdp/driver.ts";
import type { RetireSteps } from "./sources/browser/chrome-scope.ts";
import { createFontEvidenceStore } from "./sources/browser/font-evidence.ts";
import type { FontEvidenceStore } from "./sources/browser/font-evidence.ts";
import { killProcessGroup, waitForGroupExit } from "./sources/browser/group-lifetime.ts";
import type { LaunchPlan } from "./sources/browser/launch-plan.ts";
import type { BrowserDriver } from "./sources/browser/port.ts";
import { fakeChromePath } from "./testing/fake-chrome-path.ts";
import { CHECKED_FONT_STACK } from "./testing/fake-font-stack.ts";
import { fakeForkPath } from "./testing/fake-fork.ts";
import type { FakeForkScenario } from "./testing/fake-fork.ts";
import { fixedRandom, fixedSeed } from "./testing/fixed-seed.ts";
import { leftovers, nothingLeft } from "./testing/leftovers.ts";
import { manualClock } from "./testing/manual-clock.ts";
import { noPins } from "./testing/no-pins.ts";
import { plannedScrapes } from "./testing/planned-scrapes.ts";
import type { PlannedScrapes, PlanningDependencies } from "./testing/planned-scrapes.ts";
import { stageTimeline } from "./testing/stage-timeline.ts";

const plannedVisits = (
  driver: BrowserDriver,
  capacity = 1,
  overrides: PlanningDependencies = {},
): PlannedScrapes => {
  const evidence = path.join(tmpdir(), `xrio-evidence-${randomUUID()}`);

  onTestFinished(async () => {
    await rm(evidence, { force: true, recursive: true });
  });

  return plannedScrapes(driver, capacity, {
    fonts: createFontEvidenceStore({ root: evidence }),
    ...overrides,
  });
};

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
  const browsers = plannedVisits(cdpDriver, 2);
  using deadline = startDeadline(timeoutMs, signal);

  try {
    return await browsers.visit({
      browserArgs: [],
      browserPath: await fakeChromePath(scenario),
      deadline,
      mode: "headless",
      pins: noPins,
      proxy: undefined,
      url: new URL("https://fake.test/page"),
    }).document;
  } finally {
    await browsers.close();
  }
};

const loadWithFork = async (scenario: FakeForkScenario, root: string, version?: string) => {
  const browsers = plannedVisits(cdpDriver, 1, {
    host: createCapabilityProbe({ root: path.join(root, "scratch") }),
  });

  using deadline = startDeadline(10_000);

  try {
    return await browsers.visit({
      browserArgs: [],
      browserPath: await fakeForkPath(scenario, { root, version }),
      deadline,
      mode: "headless",
      pins: noPins,
      proxy: undefined,
      url: new URL("https://fake.test/page"),
    }).document;
  } finally {
    await browsers.close();
  }
};

describe("browsers on the kit fork", () => {
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-fork-"));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("probes the package before launch and renders", async () => {
    await expect(loadWithFork("kit", root)).resolves.toMatchObject({ status: 200 });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("refuses a launched Chrome whose version differs from the probed version", async () => {
    await expect(loadWithFork("kit", root, "154.0.8037.99")).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") &&
        error.message.startsWith("Chrome launched as version 154.0.8037.57, but the Xrio fork") &&
        error.message.endsWith("reported 154.0.8037.99 to its version probe."),
    );
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("rejects with BROWSER_LAUNCH_FAILED naming the package when its dump is broken", async () => {
    await expect(loadWithFork("broken-dump", root)).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") &&
        error.message.startsWith("The Xrio fork package at ") &&
        error.message.endsWith("failed its probe: the dump has no xrio-knobs header."),
    );
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

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

    const browsers = plannedVisits(observedDriver, 1);
    using deadline = startDeadline(LAUNCH_DEADLINE_MS);

    await expect(
      browsers.visit({
        browserArgs: [],
        browserPath: await fakeChromePath("slow-start"),
        deadline,
        mode: "headless",
        pins: noPins,
        proxy: undefined,
        url: new URL("https://fake.test/page"),
      }).document,
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
      const browsers = plannedVisits(cdpDriver, 1);
      using deadline = startDeadline(LAUNCH_DEADLINE_MS, undefined, clock);

      const settled = Promise.allSettled([
        browsers.visit({
          browserArgs: [],
          browserPath: await fakeChromePath(scenario),
          deadline,
          mode: "headless",
          pins: noPins,
          proxy: undefined,
          url: new URL("https://fake.test/page"),
        }).document,
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

describe("planned visits", () => {
  it("queues past maxBrowsers and counts the wait against the deadline", async () => {
    const browsers = plannedVisits(cdpDriver, 1);
    const request = await queuedRequest();
    using held = startDeadline(1500);
    using queued = startDeadline(200);

    const launchesBefore = launchStages.length;

    const first = browsers.visit({ ...request, deadline: held }).document;
    const second = browsers.visit({ ...request, deadline: queued }).document;

    await expect(second).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(first).rejects.toMatchObject({ code: "TIMEOUT" });
    await browsers.close();
    expect(launchStages.length - launchesBefore).toBe(1);
  });

  it("lets accepted work finish when closed, and rejects new work afterwards", async () => {
    const browsers = plannedVisits(cdpDriver, 1);
    const request = await queuedRequest();
    const normal = { ...request, browserPath: await fakeChromePath("normal") };
    using held = startDeadline(1000);
    using queued = startDeadline(10_000);

    const settled: string[] = [];

    const first = browsers.visit({ ...request, deadline: held }).document;

    const second = (async () => {
      const document = await browsers.visit({ ...normal, deadline: queued }).document;

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
    await expect(browsers.capture({ ...normal, deadline: queued })).rejects.toMatchObject({
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
  const browsers = plannedVisits(driver, 1, { retire: steps });
  const owner = new AbortController();
  const browserPath = await fakeChromePath(scenario);
  using deadline: Deadline & Disposable = startDeadline(timeoutMs);

  const visit = browsers.visit({
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

  it("leaves no scratch directory behind when planning throws", async () => {
    const browsers = plannedVisits(cdpDriver, 1, {
      host: async () => await Promise.reject(new Error("Planning failed.")),
    });

    using deadline = startDeadline(10_000);

    const visit = browsers.visit({
      browserArgs: [],
      browserPath: await fakeChromePath("normal"),
      deadline,
      mode: "headless",
      pins: noPins,
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

type PlanningOverrides = NonNullable<Parameters<typeof plannedVisits>[2]>;

const loadTwice = async (steps: PlanningOverrides, firstScenario: string) => {
  const browsers = plannedVisits(cdpDriver, 1, steps);
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
    browsers.visit({ ...request, browserPath: await fakeChromePath(firstScenario) }).document,
  );

  const second = await settledValue(
    browsers.visit({ ...request, browserPath: await fakeChromePath("normal") }).document,
  );

  await browsers.close();

  return { first, left: await leftovers(), second };
};

describe("planning between admission and start", () => {
  it("releases admission when a planning step throws before start", async () => {
    let plans = 0;

    const anonymous = anonymousSessions();

    const failFirstPlan: SessionManager["hold"] = async (intent, checks, deadline) => {
      plans += 1;

      if (plans === 1) {
        throw new Error("The session step failed.");
      }

      return await anonymous.hold(intent, checks, deadline);
    };

    await expect(loadTwice({ sessions: { hold: failFirstPlan } }, "normal")).resolves.toMatchObject(
      {
        first: { error: { message: "The session step failed." } },
        left: nothingLeft,
        second: { value: { status: 200 } },
      },
    );
  });

  it("releases admission when the identity step throws before start", async () => {
    let claims = 0;
    const root = path.join(tmpdir(), `xrio-evidence-${randomUUID()}`);

    onTestFinished(async () => {
      await rm(root, { force: true, recursive: true });
    });

    const store = createFontEvidenceStore({ root });

    const failFirstClaim: FontEvidenceStore = {
      claim: async (...claim) => {
        claims += 1;

        if (claims === 1) {
          throw new Error("The identity step failed.");
        }

        return await store.claim(...claim);
      },
    };

    await expect(loadTwice({ fonts: failFirstClaim }, "normal")).resolves.toMatchObject({
      first: { error: { message: "The identity step failed." } },
      left: nothingLeft,
      second: { value: { status: 200 } },
    });
  });

  it("stops a visit when its session's ownership aborts, then admits the next scrape", async () => {
    let plans = 0;

    const anonymous = anonymousSessions();

    const loseFirstOwnership: SessionManager["hold"] = async (intent, checks, deadline) => {
      plans += 1;
      const hold = await anonymous.hold(intent, checks, deadline);

      return plans === 1
        ? {
            ...hold,
            bind: (request) =>
              new HeldDeadline(request, AbortSignal.timeout(ABORT_DURING_LAUNCH_MS)),
          }
        : hold;
    };

    await expect(
      loadTwice({ sessions: { hold: loseFirstOwnership } }, "slow-start"),
    ).resolves.toMatchObject({
      first: { error: { code: "SESSION_UNAVAILABLE", details: { reason: "ownership-lost" } } },
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

    const browsers = plannedVisits(failedCloseDriver, 1);

    using deadline = startDeadline(10_000);

    try {
      await expect(
        browsers.visit({
          ...(await normalRequest(deadline)),
          browserPath: await fakeChromePath("ignore-close"),
        }).document,
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

    const browsers = plannedVisits(failedLaunchDriver, 1);

    using deadline = startDeadline(10_000);
    const request = await normalRequest(deadline);

    const first = browsers.visit({
      ...request,
      browserPath: await fakeChromePath("ignore-close"),
    }).document;

    const second = browsers.visit(request).document;

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

    const browsers = plannedVisits(failedLaunchDriver, 1);
    using deadline = startDeadline(15_000);
    const request = await normalRequest(deadline);

    const first = browsers.visit({
      ...request,
      browserPath: await fakeChromePath("ignore-close"),
    }).document;

    const second = browsers.visit(request).document;

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

    const browsers = plannedVisits(hungCloseDriver, 1);
    using deadline = startDeadline(10_000);
    const request = await normalRequest(deadline);

    const first = browsers.visit({
      ...request,
      browserPath: await fakeChromePath("ignore-close"),
    }).document;

    const second = browsers.visit(request).document;

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

    const browsers = plannedVisits(cdpDriver, 1, {
      retire: { retireProcessGroup: async () => await hangingExit.promise },
    });

    using deadline = startDeadline(20_000);

    try {
      await expect(browsers.visit(await normalRequest(deadline)).document).resolves.toMatchObject({
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

    const browsers = plannedVisits(cdpDriver, 1, {
      retire: {
        removeScratchDir: async (scratch, signal) => {
          removals.push({ directory: scratch.path, signal });
          await hangingRemoval.promise;
        },
      },
    });

    using deadline = startDeadline(20_000);

    try {
      await expect(browsers.visit(await normalRequest(deadline)).document).resolves.toMatchObject({
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

    const browsers = plannedVisits(silentDriver, 1);
    using deadline = startDeadline(10_000);

    try {
      await expect(browsers.visit(await normalRequest(deadline)).document).rejects.toSatisfy(
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

    const browsers = plannedVisits(heldDriver, 1);
    using deadline = startDeadline(10_000);
    const visit = browsers.visit(await normalRequest(deadline));

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
      const browsers = plannedVisits(cdpDriver, 1);
      using deadline = startDeadline(10_000);

      const visit = browsers.visit({
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
    const browsers = plannedVisits(cdpDriver, 1);
    using deadline = startDeadline(10_000);
    const visit = browsers.visit(await normalRequest(deadline));
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
    const browsers = plannedVisits(cdpDriver, 1);
    using deadline = startDeadline(10_000);
    using stages = stageTimeline(new Set(["queue", "launch"]));

    await browsers.close();

    await expect(
      stages.recording(async () => browsers.visit(await normalRequest(deadline))),
    ).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    expect(stages.timeline).toStrictEqual([]);
  });

  it("queues a load behind a started visit on maxBrowsers 1", async () => {
    const browsers = plannedVisits(cdpDriver, 1);
    using deadline = startDeadline(20_000);
    using stages = stageTimeline(new Set(["launch", "teardown"]));
    const request = await normalRequest(deadline);

    await stages.recording(async () => {
      const visit = browsers.visit(request);

      await Promise.all([visit.document, visit.closed, browsers.visit(request).document]);
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

  const browsers = plannedVisits(recordingDriver, 1, steps);
  using deadline = startDeadline(10_000);

  await browsers.visit({
    ...(await normalRequest(deadline)),
    browserArgs,
    mode,
    pins: { ...noPins, timezone },
  }).document;
  await browsers.close();

  return launched[0];
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

  it("writes the checked font stack's fonts.conf into the scratch before Chrome starts", async () => {
    const seen: { file: string | undefined; config: string }[] = [];

    const readingDriver: BrowserDriver = {
      launch: async (plan, deadline, owned, deferCleanup) => {
        const file = plan.env.FONTCONFIG_FILE;

        seen.push({ config: file === undefined ? "" : await readFile(file, "utf-8"), file });

        return await cdpDriver.launch(plan, deadline, owned, deferCleanup);
      },
    };

    using deadline = startDeadline(10_000);

    const browsers = plannedVisits(readingDriver, 1, {
      host: async () => await Promise.resolve({ fontStack: CHECKED_FONT_STACK, platform: "linux" }),
    });

    await browsers.visit(await normalRequest(deadline)).document;
    await browsers.close();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.file).toMatch(/\/home\/identity-files\/fonts\.conf$/u);
    expect(seen[0]?.config).toContain("<dir>/opt/xrio-chrome/fontstack/share</dir>");
  });

  it.each([
    {
      capabilities: { platform: "linux" },
      host: "Linux",
      switches: [
        "--enable-unsafe-swiftshader",
        "--use-fake-device-for-media-stream=device-count=0",
      ],
    },
    {
      capabilities: { platform: "linux", readableRenderNode: true },
      host: "Linux with a render node",
      switches: [
        "--use-gl=angle",
        "--use-angle=vulkan",
        "--use-fake-device-for-media-stream=device-count=0",
      ],
    },
    { capabilities: { platform: "darwin" }, host: "darwin", switches: [] },
  ] satisfies readonly {
    readonly capabilities: HostCapabilities;
    readonly host: string;
    readonly switches: readonly string[];
  }[])(
    "selects the GL backend and the media devices from the capabilities of $host",
    async ({ capabilities, switches }) => {
      const plan = await launchPlanOf({
        host: async () => await Promise.resolve(capabilities),
      });

      expect(
        plan?.args.filter(
          (value) =>
            (value.startsWith("--use-") && value !== BASELINE_USE_SWITCH) ||
            value === "--enable-unsafe-swiftshader",
        ),
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

describe("the launch identity check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("plans the identity, then runs as the verify stage after launch and before navigation", async () => {
    const browsers = plannedVisits(cdpDriver, 1);
    using deadline = startDeadline(10_000);

    using stages = stageTimeline(
      new Set(["identity", "launch", "verify", "navigation", "capture", "teardown"]),
    );

    await stages.recording(
      async () => await browsers.visit(await normalRequest(deadline)).document,
    );
    await browsers.close();
    expect(stages.timeline).toStrictEqual([
      "identity",
      "launch",
      "verify",
      "navigation",
      "capture",
      "teardown",
    ]);
  });

  it("resolves the document with the report of what the launch read", async () => {
    vi.stubEnv("TZ", "UTC");

    const browsers = plannedVisits(cdpDriver, 1, {
      host: async () => await Promise.resolve({ platform: "linux" }),
      random: fixedRandom,
    });

    using deadline = startDeadline(10_000);
    const document = await browsers.visit(await normalRequest(deadline)).document;

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
        screen: { availHeight: 1018, availTop: 32, height: 1050, width: 1680 },
        timeZone: "UTC",
        window: { outerHeight: 1018, outerWidth: 1680, screenX: 0, screenY: 32 },
      },
      seed: fixedSeed,
      surfaces: {
        fonts: { reason: "no fontstack/ beside the binary", source: "host" },
        timezone: { source: "host", zone: "UTC" },
      },
      tells: ["headless-token", "host-zone-utc", "host-fonts"],
    });
  });

  it("reports a pinned UTC as the caller's choice, not as the host's", async () => {
    vi.stubEnv("TZ", "UTC");

    const browsers = plannedVisits(cdpDriver, 1, {
      host: async () => await Promise.resolve({ platform: "linux" }),
    });

    using deadline = startDeadline(10_000);

    const document = await browsers.visit({
      ...(await normalRequest(deadline)),
      pins: { ...noPins, timezone: "UTC" },
    }).document;

    await browsers.close();
    expect(document.identity).toMatchObject({
      surfaces: { timezone: { source: "pin", zone: "UTC" } },
      tells: ["headless-token", "host-fonts"],
    });
  });

  it("rejects a drifted zone before navigation, names it, and still tears Chrome down", async () => {
    vi.stubEnv("TZ", "America/Chicago");

    const browsers = plannedVisits(cdpDriver, 1);
    using deadline = startDeadline(10_000);

    using stages = stageTimeline(
      new Set(["launch", "verify", "navigation", "capture", "teardown"]),
    );

    const visit = stages.recording(async () =>
      browsers.visit({
        ...(await normalRequest(deadline)),
        browserPath: await fakeChromePath("identity-drift"),
      }),
    );

    const { closed: closing, document: rendering } = await visit;
    const document = await settledValue(rendering);
    const closed = await closing;
    const leftAtClose = await leftovers();

    await browsers.close();
    expect({ closed, document, leftAtClose, timeline: stages.timeline }).toMatchObject({
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
      timeline: ["launch", "verify", "teardown"],
    });
  });

  it("rejects a page with no WebGL context before navigation", async () => {
    const browsers = plannedVisits(cdpDriver, 1);
    using deadline = startDeadline(10_000);

    using stages = stageTimeline(
      new Set(["launch", "verify", "navigation", "capture", "teardown"]),
    );

    const document = await stages.recording(
      async () =>
        await settledValue(
          browsers.visit({
            ...(await normalRequest(deadline)),
            browserPath: await fakeChromePath("no-webgl"),
          }).document,
        ),
    );

    await browsers.close();
    expect({ document, timeline: stages.timeline }).toMatchObject({
      document: {
        error: {
          code: "BROWSER_LAUNCH_FAILED",
          details: {
            mismatches: [{ expected: true, field: "webgl", observed: false, surface: "gpu" }],
          },
          message: "Chrome's launch identity does not match Xrio's plan: gpu webgl.",
        },
      },
      timeline: ["launch", "verify", "teardown"],
    });
  });

  it("rejects a Chrome that ignores the pinned locale before navigation", async () => {
    const browsers = plannedVisits(cdpDriver, 1, {
      host: async () => await Promise.resolve({ platform: "linux" }),
    });

    using deadline = startDeadline(10_000);

    using stages = stageTimeline(
      new Set(["launch", "verify", "navigation", "capture", "teardown"]),
    );

    const document = await stages.recording(
      async () =>
        await settledValue(
          browsers.visit({
            ...(await normalRequest(deadline)),
            pins: { display: undefined, locale: "de-DE", timezone: undefined },
          }).document,
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
    const browsers = plannedVisits(cdpDriver, 1, { random: fixedRandom });
    using deadline = startDeadline(10_000);

    const { document } = browsers.visit({
      ...(await normalRequest(deadline)),
      browserPath: await fakeChromePath("unsized-window"),
    });

    await expect(document).resolves.toMatchObject({
      identity: { observed: { window: { outerHeight: 1018, outerWidth: 1680 } } },
      status: 200,
    });
    await browsers.close();
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

      const browsers = plannedVisits(hangingRead, 1);
      using deadline = startDeadline(deadlineMs, undefined, clock);
      const visit = browsers.visit(await normalRequest(deadline));

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

describe("a named session's device record", () => {
  const record = {
    device: {
      cores: 0,
      fonts: { kind: "system" },
      gpu: { backend: "swiftshader", persona: null },
      memoryGb: 0,
      screen: { height: 1000, width: 1700, workArea: { bottom: 50, left: 0, right: 0, top: 0 } },
      voices: { kind: "system" },
      window: { height: 800, kind: "floating", width: 1300, x: 100, y: 60 },
    },
    policy: { locale: "en-US", timezone: { kind: "pinned", zone: "UTC" } },
    schema: 1,
    seed: "00000000000000a1",
  } as const;

  const namedSession: SessionManager = {
    hold: async (_intent, _checks, deadline) => {
      deadline.throwIfExpired();

      return await Promise.resolve({
        [Symbol.asyncDispose]: async () => {
          await Promise.resolve();
        },
        bind: (request: Deadline) => new HeldDeadline(request, new AbortController().signal),
        device: { kind: "record" as const, record },
        finish: async () => {
          await Promise.resolve();
        },
        revisitWanted: () => false,
      });
    },
  };

  it("presents the stored device instead of drawing a seed", async () => {
    const browsers = plannedVisits(cdpDriver, 1, {
      host: async () => await Promise.resolve({ platform: "linux" }),
      random: () => {
        throw new Error("A named session draws no seed.");
      },
      sessions: namedSession,
    });

    using deadline = startDeadline(10_000);
    const document = await browsers.visit(await normalRequest(deadline)).document;

    await browsers.close();
    expect(document.identity).toMatchObject({
      observed: {
        screen: { availHeight: 950, height: 1000, width: 1700 },
        window: { outerHeight: 800, outerWidth: 1300, screenX: 100, screenY: 60 },
      },
      record,
      seed: "00000000000000a1",
      surfaces: { seed: { source: "record" }, timezone: { source: "pin", zone: "UTC" } },
    });
  });

  it("refuses a headed scrape of a headless record before Chrome launches", async () => {
    const browsers = plannedVisits(cdpDriver, 1, { sessions: namedSession });
    using deadline = startDeadline(10_000);

    const document = await settledValue(
      browsers.visit({ ...(await normalRequest(deadline)), mode: "headed" }).document,
    );

    await browsers.close();
    expect({ document, left: await leftovers() }).toMatchObject({
      document: {
        error: {
          code: "INVALID_OPTIONS",
          message:
            "The session's device record fixes its mode; a scrape in that session cannot change it.",
        },
      },
      left: nothingLeft,
    });
  });

  it("refuses a scrape that pins another zone before Chrome launches", async () => {
    const browsers = plannedVisits(cdpDriver, 1, { sessions: namedSession });
    using deadline = startDeadline(10_000);

    const document = await settledValue(
      browsers.visit({
        ...(await normalRequest(deadline)),
        pins: { ...noPins, timezone: "America/New_York" },
      }).document,
    );

    await browsers.close();
    expect({ document, left: await leftovers() }).toMatchObject({
      document: {
        error: {
          code: "INVALID_OPTIONS",
          message:
            "The session's device record fixes its timezone; a scrape in that session cannot change it.",
        },
      },
      left: nothingLeft,
    });
  });
});

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

      const browsers = plannedVisits(cdpDriver, 1, {
        host: async () => await Promise.resolve({ platform: "linux" }),
        random: fixedRandom,
      });

      using deadline = startDeadline(10_000);
      subscribe("xrio:event", record);

      const document = await settledValue(
        browsers
          .visit({
            ...(await normalRequest(deadline)),
            browserPath: await fakeChromePath(scenario),
          })
          .document.finally(() => {
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
          seed: fixedSeed,
          surfaces: {
            automation: null,
            gpu: { backend: "swiftshader", persona: null },
            leaks: { dnsOverHttps: "off", networkPrediction: "off" },
            locale: { languages: ["en-US", "en"], tag: "en-US" },
            media: { devices: { audioinput: 1, audiooutput: 1, videoinput: 0 }, source: "fake" },
            screen: {
              layout: "gnome",
              size: { height: 1050, width: 1680 },
              source: "drawn",
              workArea: { bottom: 0, left: 0, right: 0, top: 32 },
            },
            timezone: { source: "host", zone: "UTC" },
            window: {
              height: 1018,
              kind: "maximized",
              source: "drawn",
              width: 1680,
              x: 0,
              y: 32,
            },
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

    const browsers = plannedVisits(
      readingAfterCaptureWith(async () => {
        stages.mark("read");

        return await Promise.resolve(SECURE_READING);
      }),
      1,
    );

    using deadline = startDeadline(10_000);

    const document = await stages.recording(
      async () => await browsers.visit(await normalRequest(deadline)).document,
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

      const browsers = plannedVisits(nearlyExpired, 1);
      using deadline = startDeadline(10_000, undefined, clock);
      const visit = browsers.visit(await normalRequest(deadline));
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

      const browsers = plannedVisits(hangingRead, 1);
      using deadline = startDeadline(deadlineMs, undefined, clock);
      const visit = browsers.visit(await normalRequest(deadline));

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

const LINUX_HOST = async () => await Promise.resolve({ platform: "linux" as const });

const PINNED_HOST = async () =>
  await Promise.resolve({ fontStack: CHECKED_FONT_STACK, platform: "linux" as const });

const fontsOf = async (browsers: PlannedScrapes, browserPath: string) => {
  using deadline = startDeadline(10_000);

  const { identity } = await browsers.visit({
    browserArgs: [],
    browserPath,
    deadline,
    mode: "headless",
    pins: noPins,
    proxy: undefined,
    url: new URL("https://fake.test/page"),
  }).document;

  if (identity === undefined || identity.mode === "http") {
    throw new Error("The visit reported no browser identity.");
  }

  return identity;
};

describe("the fonts evidence across visits", () => {
  let root = "";
  let normal = "";
  let drifting = "";
  let unresolved = "";
  const clock = { elapsedMs: 0 };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-fonts-visits-"));
    normal = await fakeChromePath("normal");
    drifting = await fakeChromePath("fonts-drift");
    unresolved = await fakeChromePath("fonts-unresolved");
  });

  afterEach(async () => {
    clock.elapsedMs = 0;
    await rm(path.join(root, "scratch"), { force: true, recursive: true });
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const storeAt = (storeRoot = path.join(root, "scratch")) =>
    createFontEvidenceStore({ now: () => 1_000_000 + clock.elapsedMs, root: storeRoot });

  const browsersFor = (maxBrowsers = 1, store = storeAt(), host = LINUX_HOST) =>
    plannedVisits(cdpDriver, maxBrowsers, { fonts: store, host });

  it("reads the full set on the first visit and only the sentinel on the next, from the stored evidence", async () => {
    const browsers = browsersFor();
    const first = await fontsOf(browsers, normal);

    clock.elapsedMs = 5_400_000;

    const second = await fontsOf(browsers, normal);

    await browsers.close();
    expect({
      coverage: [first.coverage.fonts, { ...second.coverage.fonts, key: "key" }],
      digests: [first.observed.fontsDigest, second.observed.fontsDigest],
    }).toStrictEqual({
      coverage: [{ state: "observed" }, { ageMs: 5_400_000, key: "key", state: "cached" }],
      digests: ["c41f09a2", "c41f09a2"],
    });
  });

  it("notes a sentinel that drifted from the stored evidence, tells fonts-drift, and gathers again", async () => {
    using seeding = startDeadline(10_000);

    const claim = await storeAt().claim(drifting, { platform: "linux" }, "en-US", seeding);

    await claim.settle({ digest: "c41f09a2", kind: "gathered", sentinel: "5e17a1b2" });

    const browsers = browsersFor();
    const drifted = await fontsOf(browsers, drifting);
    const regathered = await fontsOf(browsers, drifting);

    await browsers.close();
    expect({
      coverage: [drifted.coverage.fonts, regathered.coverage.fonts],
      digests: [drifted.observed.fontsDigest, regathered.observed.fontsDigest],
      notes: drifted.notes,
      tells: [drifted.tells.includes("fonts-drift"), regathered.tells.includes("fonts-drift")],
    }).toStrictEqual({
      coverage: [{ reason: "fonts-drift", state: "unchecked" }, { state: "observed" }],
      digests: [null, "c41f09a2"],
      notes: [
        { expected: "5e17a1b2", field: "fontsSentinel", observed: "dead0000", surface: "fonts" },
      ],
      tells: [true, false],
    });
  });

  it("never stores the evidence of a gathering launch whose pinned stack resolved no sentinel family", async () => {
    const browsers = browsersFor(1, storeAt(), PINNED_HOST);
    const first = await fontsOf(browsers, unresolved);
    const second = await fontsOf(browsers, unresolved);

    await browsers.close();
    expect({
      coverage: [first.coverage.fonts, second.coverage.fonts],
      digests: [first.observed.fontsDigest, second.observed.fontsDigest],
      notes: first.notes,
      tells: [first.tells.includes("fonts-drift"), second.tells.includes("fonts-drift")],
    }).toStrictEqual({
      coverage: [{ state: "observed" }, { state: "observed" }],
      digests: ["c41f09a2", "c41f09a2"],
      notes: [
        { expected: true, field: "fontsSentinelResolved", observed: false, surface: "fonts" },
      ],
      tells: [true, true],
    });
  });

  it("reads the full set in exactly one of several concurrent visits", async () => {
    const browsers = browsersFor(3);

    const reports = await Promise.all([
      fontsOf(browsers, normal),
      fontsOf(browsers, normal),
      fontsOf(browsers, normal),
    ]);

    await browsers.close();

    const states = reports.map(({ coverage }) => coverage.fonts.state);

    expect(states.toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
      "cached",
      "cached",
      "observed",
    ]);
  });

  it("still resolves, and keeps the evidence in memory, when it cannot be written to disk", async () => {
    const blocked = path.join(root, "blocked");

    await writeFile(blocked, "a file where the scratch root should be");

    const browsers = browsersFor(1, storeAt(blocked));
    const first = await fontsOf(browsers, normal);
    const second = await fontsOf(browsers, normal);

    await browsers.close();
    expect([first.coverage.fonts.state, second.coverage.fonts.state]).toStrictEqual([
      "observed",
      "cached",
    ]);
  });
});
