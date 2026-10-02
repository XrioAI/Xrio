import { subscribe } from "node:diagnostics_channel";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { isXrioError } from "../../errors.ts";
import { fakeChromePath } from "../../testing/fake-chrome-path.ts";
import { leftovers, nothingLeft } from "../../testing/leftovers.ts";
import { createBrowsers } from "./browsers.ts";
import { patchrightDriver } from "./patchright/driver.ts";
import type { BrowserDriver } from "./port.ts";

const ABORT_DURING_LAUNCH_MS = 200;

const LAUNCH_DEADLINE_MS = 500;

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

const load = async (scenario: string, timeoutMs = 10_000, signal?: AbortSignal) => {
  const browsers = createBrowsers(patchrightDriver, 2);
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
    await expect(load("crash-on-navigate")).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
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
      launch: async (plan, deadline, deferCleanup) =>
        await patchrightDriver.launch(plan, deadline, (cleanup) => {
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

describe(createBrowsers, () => {
  it("queues past maxBrowsers and counts the wait against the deadline", async () => {
    const browsers = createBrowsers(patchrightDriver, 1);
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
    const browsers = createBrowsers(patchrightDriver, 1);
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
