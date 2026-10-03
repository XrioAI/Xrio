import { subscribe } from "node:diagnostics_channel";
import { rm } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import { isXrioError } from "../../errors.ts";
import { fakeChromePath } from "../../testing/fake-chrome-path.ts";
import { leftovers, nothingLeft } from "../../testing/leftovers.ts";
import { findBrowserPid, killProcessGroup, scratchRoot, waitForExit } from "./browser-process.ts";
import { createBrowsers } from "./browsers.ts";
import { BROWSER_DRIVERS, isBrowserDriverName } from "./drivers.ts";
import type { BrowserDriverName } from "./drivers.ts";
import { patchrightDriver } from "./patchright/driver.ts";
import type { BrowserDriver } from "./port.ts";

const ABORT_DURING_LAUNCH_MS = 200;

const LAUNCH_DEADLINE_MS = 500;

const TEARDOWN_SETTLED_WITHIN_MS = 11_500;

const DRIVER_NAMES = Object.keys(BROWSER_DRIVERS).filter(isBrowserDriverName);

const isLaunchStage = (message: unknown): message is { stage: "launch"; durationMs: number } =>
  typeof message === "object" &&
  message !== null &&
  "stage" in message &&
  message.stage === "launch" &&
  "durationMs" in message &&
  typeof message.durationMs === "number";

const launchStages: number[] = [];

subscribe("xrio:stage", (message) => {
  if (isLaunchStage(message)) {
    launchStages.push(message.durationMs);
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

const load = async (
  driver: BrowserDriverName,
  scenario: string,
  timeoutMs = 10_000,
  signal?: AbortSignal,
) => {
  const browsers = createBrowsers(BROWSER_DRIVERS[driver], 2);
  using deadline = startDeadline(timeoutMs, signal);

  try {
    return await browsers.load({
      browserPath: await fakeChromePath(scenario),
      deadline,
      mode: "headless",
      proxy: undefined,
      url: new URL("https://fake.test/page"),
    });
  } finally {
    await browsers.close();
  }
};

describe.each(DRIVER_NAMES)("browser lifecycle on the fake browser, %s", (driver) => {
  it.each(["normal", "fragmented"])("renders over the pipe with %s framing", async (scenario) => {
    const document = await load(driver, scenario);

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
    await expect(load(driver, "no-start")).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") &&
        error.details.stderr.includes("fake chrome cannot start"),
    );
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("refuses a Chrome older than the supported range", async () => {
    await expect(load(driver, "old")).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") && error.message.includes("older than 150"),
    );
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reports a browser that dies mid-scrape", async () => {
    await expect(load(driver, "crash-on-navigate")).rejects.toMatchObject({
      code: "BROWSER_CRASHED",
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("kills a browser that ignores Browser.close", async () => {
    await expect(load(driver, "ignore-close")).resolves.toMatchObject({ status: 200 });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("cleans up after a caller abort during launch", async () => {
    const reason = new Error("Stopped by caller");
    const controller = new AbortController();
    const loading = load(driver, "slow-start", 10_000, controller.signal);

    setTimeout(() => {
      controller.abort(reason);
    }, ABORT_DURING_LAUNCH_MS);
    await expect(loading).rejects.toBe(reason);
    await expect(
      load(driver, "slow-start", 10_000, AbortSignal.timeout(ABORT_DURING_LAUNCH_MS)),
    ).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("rejects with TIMEOUT during launch while teardown is still cleaning up", async () => {
    const cleanups: { settled: boolean }[] = [];

    const observedDriver: BrowserDriver = {
      launch: async (plan, deadline, deferCleanup) =>
        await BROWSER_DRIVERS[driver].launch(plan, deadline, (cleanup) => {
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
        browserPath: await fakeChromePath("slow-start"),
        deadline,
        mode: "headless",
        proxy: undefined,
        url: new URL("https://fake.test/page"),
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(cleanups).toStrictEqual([{ settled: false }]);
    await browsers.close();
    expect(cleanups).toStrictEqual([{ settled: true }]);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

const queuedRequest = async () => ({
  browserPath: await fakeChromePath("slow-start"),
  mode: "headless" as const,
  proxy: undefined,
  url: new URL("https://fake.test/"),
});

describe.each(DRIVER_NAMES)("createBrowsers on %s", (driver) => {
  it("queues past maxBrowsers and counts the wait against the deadline", async () => {
    const browsers = createBrowsers(BROWSER_DRIVERS[driver], 1);
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
    const browsers = createBrowsers(BROWSER_DRIVERS[driver], 1);
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

const normalRequest = async (deadline: Deadline) => ({
  browserPath: await fakeChromePath("normal"),
  deadline,
  mode: "headless" as const,
  proxy: undefined,
  url: new URL("https://fake.test/page"),
});

describe("bounded teardown on the fake browser", () => {
  it("kills the known browser without a process scan when Browser.close fails", async () => {
    const pids: number[] = [];
    let scans = 0;

    const failedCloseDriver: BrowserDriver = {
      launch: async (plan, deadline, deferCleanup) => {
        const browser = await patchrightDriver.launch(plan, deadline, deferCleanup);

        pids.push(browser.pid);

        return {
          ...browser,
          close: async () => {
            await nextTurn();
            throw new Error("Browser.close went unanswered");
          },
        };
      },
    };

    const browsers = createBrowsers(failedCloseDriver, 1, {
      findBrowserPid: async () => {
        scans += 1;

        return await Promise.withResolvers<number>().promise;
      },
    });

    using deadline = startDeadline(10_000);

    try {
      await expect(
        browsers.load({
          ...(await normalRequest(deadline)),
          browserPath: await fakeChromePath("ignore-close"),
        }),
      ).resolves.toMatchObject({ status: 200 });
      await browsers.close();
      expect(scans).toBe(0);
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    } finally {
      for (const pid of pids) {
        killProcessGroup(pid);
      }

      await browsers.close();
    }
  });

  it("continues to process discovery after a deferred launch cleanup hangs and admits queued work", async () => {
    const hangingCleanup = Promise.withResolvers<"released">();
    const scannedProfiles: string[] = [];
    let launches = 0;

    const failedLaunchDriver: BrowserDriver = {
      launch: async (plan, deadline, deferCleanup) => {
        const browser = await patchrightDriver.launch(plan, deadline, deferCleanup);

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

    const browsers = createBrowsers(failedLaunchDriver, 1, {
      findBrowserPid: async (profile, budgetMs, signal) => {
        scannedProfiles.push(profile);

        return await findBrowserPid(profile, budgetMs, signal);
      },
    });

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
      expect(scannedProfiles).toHaveLength(1);
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    } finally {
      hangingCleanup.resolve("released");
      await browsers.close();
    }
  });

  it("retains an unknown browser after launch cleanup and discovery hang while admitting queued work", async () => {
    const hangingCleanup = Promise.withResolvers<"released">();
    const hangingScan = Promise.withResolvers<number>();
    const launched: { pid: number; scratch: string }[] = [];
    const reported = incompleteTeardowns.length;
    let scans = 0;

    const failedLaunchDriver: BrowserDriver = {
      launch: async (plan, deadline, deferCleanup) => {
        const browser = await patchrightDriver.launch(plan, deadline, deferCleanup);

        launched.push({ pid: browser.pid, scratch: path.dirname(plan.directories.profile) });

        if (launched.length === 1) {
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

    const browsers = createBrowsers(failedLaunchDriver, 1, {
      findBrowserPid: async (profile, budgetMs, signal) => {
        scans += 1;

        return scans === 1
          ? await hangingScan.promise
          : await findBrowserPid(profile, budgetMs, signal);
      },
    });

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
        `Chrome outlived its teardown; ${unconfirmed.scratch} is left for the sweep.`,
      ]);
      await expect(leftovers()).resolves.toStrictEqual({
        directories: [path.basename(unconfirmed.scratch)],
        processes: [unconfirmed.pid],
      });
      expect(scans).toBe(1);
    } finally {
      hangingCleanup.resolve("released");
      hangingScan.resolve(0);

      for (const browser of launched) {
        killProcessGroup(browser.pid);
      }

      await Promise.all(launched.map(async ({ pid }) => await waitForExit(pid)));
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
      launch: async (plan, deadline, deferCleanup) => {
        const browser = await patchrightDriver.launch(plan, deadline, deferCleanup);

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

    const browsers = createBrowsers(patchrightDriver, 1, {
      waitForExit: async () => await hangingExit.promise,
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

    const browsers = createBrowsers(patchrightDriver, 1, {
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
