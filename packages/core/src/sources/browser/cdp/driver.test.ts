import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../../deadline.ts";
import type { Clock } from "../../../deadline.ts";
import { isXrioError } from "../../../errors.ts";
import { planIdentity } from "../../../humanizer/humanizer.ts";
import { fakeChromePath } from "../../../testing/fake-chrome-path.ts";
import { leftovers, nothingLeft } from "../../../testing/leftovers.ts";
import { manualClock } from "../../../testing/manual-clock.ts";
import { createScratchDir, removeScratchDir } from "../browser-process.ts";
import { createBrowsers } from "../browsers.ts";
import { hostCapabilities } from "../capabilities.ts";
import { planLaunch } from "../launch-plan.ts";
import { CLOSE_BUDGET_MS } from "../port.ts";
import { renderDocument } from "../render.ts";
import { cdpDriver } from "./driver.ts";

const LAUNCH_CAP_MS = 30_000;

const SCRAPE_DEADLINE_MS = 120_000;

const WORLD_AND_PAGE_COMMANDS = new Set([
  "Page.createIsolatedWorld",
  "Page.navigate",
  "Runtime.evaluate",
]);

const isText = (value: unknown): value is string => typeof value === "string";

const isSentCommand = (message: unknown): message is { method: string; scope: string } =>
  typeof message === "object" &&
  message !== null &&
  "method" in message &&
  typeof message.method === "string" &&
  "scope" in message &&
  typeof message.scope === "string";

const isRebind = (message: unknown): message is { event: "document-rebind"; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "document-rebind" &&
  "detail" in message &&
  typeof message.detail === "string";

describe("the CDP driver's launch", () => {
  it("fails a launch whose first page never attaches within 30 s, long before the scrape deadline", async () => {
    const { advance, clock } = manualClock();
    const capStarted = Promise.withResolvers<"started">();

    const watched: Clock = {
      now: clock.now,
      setTimer: (delayMs, onTimeout) => {
        if (delayMs === LAUNCH_CAP_MS) {
          capStarted.resolve("started");
        }

        return clock.setTimer(delayMs, onTimeout);
      },
    };

    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(SCRAPE_DEADLINE_MS, undefined, watched);

    const loading = browsers.load({
      browserArgs: [],
      browserPath: await fakeChromePath("slow-start"),
      deadline,
      mode: "headless",
      proxy: undefined,
      url: new URL("https://fake.test/page"),
    });

    await capStarted.promise;
    advance(LAUNCH_CAP_MS);

    await expect(loading).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") &&
        error.details.stderr.startsWith("Chrome opened no page within 30000 ms."),
    );
    expect(deadline.signal.aborted).toBeFalsy();
    await browsers.close();
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reports a browser that dies after cutting off the capture as crashed, not as a timeout", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(10_000);

    try {
      await expect(
        browsers.load({
          browserArgs: [],
          browserPath: await fakeChromePath("exit-after-capture-error"),
          deadline,
          mode: "headless",
          proxy: undefined,
          url: new URL("https://fake.test/page"),
        }),
      ).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
    } finally {
      await browsers.close();
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

describe("the CDP driver's documents", () => {
  it("rejects an isolated read with the error the page threw", async () => {
    const scratch = await createScratchDir(Date.now());

    const plan = planLaunch({
      browserArgs: [],
      browserPath: await fakeChromePath("evaluate-throws"),
      display: undefined,
      headless: true,
      identity: planIdentity({
        capabilities: hostCapabilities(),
        exit: { facts: { kind: "unknown" }, route: "direct" },
        hostZone: undefined,
        mode: "headless",
      }).inputs,
      scratchDir: scratch.path,
      xauthority: undefined,
    });

    using deadline = startDeadline(10_000);

    const browser = await cdpDriver.launch(
      plan,
      deadline,
      () => {},
      () => {},
    );

    try {
      await expect(browser.evaluateIsolated("location.href", isText, deadline)).rejects.toThrow(
        "Error: fake page failure",
      );
    } finally {
      await browser.close(CLOSE_BUDGET_MS);
      await removeScratchDir(scratch);
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("resolves a navigation only once its own document has committed", async () => {
    const scratch = await createScratchDir(Date.now());

    const plan = planLaunch({
      browserArgs: [],
      browserPath: await fakeChromePath("startup-blank-commit"),
      display: undefined,
      headless: true,
      identity: planIdentity({
        capabilities: hostCapabilities(),
        exit: { facts: { kind: "unknown" }, route: "direct" },
        hostZone: undefined,
        mode: "headless",
      }).inputs,
      scratchDir: scratch.path,
      xauthority: undefined,
    });

    using deadline = startDeadline(10_000);

    const browser = await cdpDriver.launch(
      plan,
      deadline,
      () => {},
      () => {},
    );

    const commits: string[] = [];

    const stop = browser.onEvent((event) => {
      if (event.type === "commit") {
        commits.push(event.loaderId);
      }
    });

    try {
      await browser.navigate("https://fake.test/page", deadline);
      expect(commits).toStrictEqual(["L1"]);
    } finally {
      stop();
      await browser.close(CLOSE_BUDGET_MS);
      await removeScratchDir(scratch);
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reads the startup page in its own world, then captures the navigated page in a new one", async () => {
    const sent: string[] = [];

    const record: ChannelListener = (message) => {
      if (isSentCommand(message) && WORLD_AND_PAGE_COMMANDS.has(message.method)) {
        sent.push(message.method);
      }
    };

    const scratch = await createScratchDir(Date.now());

    const plan = planLaunch({
      browserArgs: [],
      browserPath: await fakeChromePath("normal"),
      display: undefined,
      headless: true,
      identity: planIdentity({
        capabilities: hostCapabilities(),
        exit: { facts: { kind: "unknown" }, route: "direct" },
        hostZone: undefined,
        mode: "headless",
      }).inputs,
      scratchDir: scratch.path,
      xauthority: undefined,
    });

    using deadline = startDeadline(10_000);

    subscribe("xrio:cdp-command", record);

    const browser = await cdpDriver.launch(
      plan,
      deadline,
      () => {},
      () => {},
    );

    try {
      await expect(browser.evaluateIsolated("location.href", isText, deadline)).resolves.toContain(
        "fake page",
      );

      const document = await renderDocument(browser, new URL("https://fake.test/page"), deadline);

      expect(document).toMatchObject({ status: 200, url: "https://fake.test/page" });
      expect(sent).toStrictEqual([
        "Page.createIsolatedWorld",
        "Runtime.evaluate",
        "Runtime.evaluate",
        "Page.navigate",
        "Page.createIsolatedWorld",
        "Runtime.evaluate",
      ]);
    } finally {
      unsubscribe("xrio:cdp-command", record);
      await browser.close(CLOSE_BUDGET_MS);
      await removeScratchDir(scratch);
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("ignores the startup about:blank commit and returns the navigated page", async () => {
    const browsers = createBrowsers(cdpDriver, 1);
    using deadline = startDeadline(10_000);

    try {
      const document = await browsers.load({
        browserArgs: [],
        browserPath: await fakeChromePath("startup-blank-commit"),
        deadline,
        mode: "headless",
        proxy: undefined,
        url: new URL("https://fake.test/page"),
      });

      expect(document).toMatchObject({ status: 200, url: "https://fake.test/page" });
      expect(document.html).toContain("<p>fake page</p>");
    } finally {
      await browsers.close();
    }

    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

describe("the CDP driver's capture", () => {
  it.each([
    { order: "in the same read", scenario: "navigate-during-capture" },
    { order: "after the capture's error", scenario: "commit-after-capture-error" },
  ])(
    "captures the newer document when a navigation cuts off the capture and commits $order",
    async ({ scenario }) => {
      const rebinds: string[] = [];

      const record: ChannelListener = (message) => {
        if (isRebind(message)) {
          rebinds.push(message.detail);
        }
      };

      subscribe("xrio:event", record);
      const browsers = createBrowsers(cdpDriver, 1);
      using deadline = startDeadline(10_000);

      try {
        const document = await browsers.load({
          browserArgs: [],
          browserPath: await fakeChromePath(scenario),
          deadline,
          mode: "headless",
          proxy: undefined,
          url: new URL("https://fake.test/page"),
        });

        expect(document).toMatchObject({ status: 200, url: "https://fake.test/page" });
        expect(document.html).toContain("<p>fake page</p>");
        expect(rebinds).toStrictEqual([
          "The main-frame document changed during capture; capturing its replacement.",
        ]);
      } finally {
        unsubscribe("xrio:event", record);
        await browsers.close();
      }

      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    },
  );
});
