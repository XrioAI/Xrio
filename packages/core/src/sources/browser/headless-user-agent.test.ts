import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { fakeChromePath } from "../../testing/fake-chrome-path.ts";
import { fakeForkPath } from "../../testing/fake-fork.ts";
import { permissionsOf, underUserPrivateGroupUmask } from "../../testing/file-modes.ts";
import { leftovers, nothingLeft } from "../../testing/leftovers.ts";
import { createCapabilityProbe } from "./capabilities.ts";
import { cdpDriver } from "./cdp/driver.ts";
import { createHeadlessUserAgentReader } from "./headless-user-agent.ts";
import type { BrowserDriver, DriverBrowser, ResultGuard } from "./port.ts";

const FAILED_TTL_MS = 60_000;

const LEARNED_TTL_MS = 24 * 60 * 60 * 1000;

const PROBE_PAGE = /^file:.*\/probe\.html$/u;

const HINTS = {
  architecture: "arm",
  bitness: "64",
  brands: [
    { brand: "Chromium", version: "154" },
    { brand: "Google Chrome", version: "154" },
    { brand: "Not A(Brand", version: "99" },
  ],
  formFactors: ["Desktop"],
  fullVersionList: [
    { brand: "Chromium", version: "154.0.8037.98" },
    { brand: "Google Chrome", version: "154.0.8037.98" },
    { brand: "Not A(Brand", version: "99.0.0.0" },
  ],
  mobile: false,
  model: "",
  platform: "macOS",
  platformVersion: "26.7.0",
  uaFullVersion: "154.0.8037.98",
  wow64: false,
};

const HEADLESS_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36";

const HEADED_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

const { uaFullVersion, ...SHARED_HINTS } = HINTS;

const PRESENTED = {
  metadata: { ...SHARED_HINTS, fullVersion: uaFullVersion },
  userAgent: HEADED_AGENT,
};

const readingOf = (userAgent: string): string => JSON.stringify({ hints: HINTS, userAgent });

const isText = (value: unknown): value is string => typeof value === "string";

const isProbed = (
  message: unknown,
): message is { event: "headless-user-agent-probed"; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "headless-user-agent-probed" &&
  "detail" in message &&
  isText(message.detail);

interface ScriptedDriver extends BrowserDriver {
  readonly visited: readonly string[];
}

const scriptedDriver = (answer: () => string): ScriptedDriver => {
  const visited: string[] = [];

  const browser: DriverBrowser = {
    clickWithin: async () => {
      await Promise.resolve();
    },
    close: async () => {
      await Promise.resolve();
    },
    evaluateIsolated: async <Result>(
      _expression: string,
      isResult: ResultGuard<Result>,
    ): Promise<Result> => {
      const value: unknown = answer();

      if (!isResult(value)) {
        throw new Error("The scripted browser answered with something unexpected.");
      }

      return await Promise.resolve(value);
    },
    navigate: async (url) => {
      visited.push(url);
      await Promise.resolve();
    },
    onEvent: () => () => {},
    product: { headless: false, major: 154, version: "154.0.8037.98" },
    responseBody: async () => await Promise.resolve(""),
    seedCookies: async () => await Promise.resolve([]),
  };

  return {
    launch: async () => await Promise.resolve(browser),
    visited,
  };
};

const failingDriver = (): ScriptedDriver => ({
  launch: async () => await Promise.reject(new Error("Chrome would not start.")),
  visited: [],
});

const counted = (driver: BrowserDriver) => {
  const launches = { count: 0 };

  const counting: BrowserDriver = {
    launch: async (...args) => {
      launches.count += 1;

      return await driver.launch(...args);
    },
  };

  return { driver: counting, launches };
};

describe(createHeadlessUserAgentReader, () => {
  let root = "";
  let binary = "";
  let now = 0;
  let probed: string[] = [];

  const record: ChannelListener = (message) => {
    if (isProbed(message)) {
      probed.push(message.detail);
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-headless-user-agent-"));
    binary = path.join(root, "chrome");
    now = 1_000_000;
    probed = [];
    await writeFile(binary, "");
    subscribe("xrio:event", record);
  });

  afterEach(async () => {
    unsubscribe("xrio:event", record);
    await rm(root, { force: true, recursive: true });
  });

  const readerWith = (
    driver: BrowserDriver,
    overrides: Partial<Parameters<typeof createHeadlessUserAgentReader>[0]> = {},
  ) =>
    createHeadlessUserAgentReader({
      budgetMs: 10_000,
      driver,
      now: () => now,
      root: path.join(root, "cache"),
      scratchRoot: path.join(root, "scratch"),
      signal: new AbortController().signal,
      ...overrides,
    });

  it("opens the probe page on the fake Chrome and reads its headless user agent there", async () => {
    const reader = readerWith(cdpDriver);

    await expect(reader(await fakeChromePath("hang-on-navigate"))).resolves.toStrictEqual({
      metadata: {
        architecture: "x86",
        bitness: "64",
        brands: [{ brand: "Chromium", version: "154" }],
        formFactors: ["Desktop"],
        fullVersion: "154.0.8037.57",
        fullVersionList: [{ brand: "Chromium", version: "154.0.8037.57" }],
        mobile: false,
        model: "",
        platform: "Linux",
        platformVersion: "6.8.0",
        wow64: false,
      },
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.57 Safari/537.36",
    });
    await expect(readdir(path.join(root, "scratch"))).resolves.toStrictEqual([]);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("swaps the HeadlessChrome token for Chrome's and keeps every client hint the browser reported", async () => {
    await expect(
      readerWith(scriptedDriver(() => readingOf(HEADLESS_AGENT)))(binary),
    ).resolves.toStrictEqual(PRESENTED);
  });

  it("presents nothing for a reading that lacks a client hint, and says why", async () => {
    const { wow64: _missing, ...partial } = HINTS;

    const reader = readerWith(
      scriptedDriver(() => JSON.stringify({ hints: partial, userAgent: HEADLESS_AGENT })),
    );

    await expect(reader(binary)).resolves.toBeUndefined();
    expect(probed).toStrictEqual([
      JSON.stringify({
        binary,
        reason: "The browser reported a malformed user agent.",
        userAgent: null,
      }),
    ]);
  });

  it("navigates only to its own file page", async () => {
    const driver = scriptedDriver(() => readingOf(HEADLESS_AGENT));

    await readerWith(driver)(binary);

    expect(driver.visited).toStrictEqual([expect.stringMatching(PROBE_PAGE)]);
  });

  it("launches once per binary, and another reader takes the answer from the file", async () => {
    const first = counted(scriptedDriver(() => readingOf(HEADLESS_AGENT)));
    const second = counted(scriptedDriver(() => readingOf(HEADLESS_AGENT)));
    const reader = readerWith(first.driver);

    await expect(Promise.all([reader(binary), reader(binary)])).resolves.toStrictEqual([
      PRESENTED,
      PRESENTED,
    ]);
    await expect(readerWith(second.driver)(binary)).resolves.toStrictEqual(PRESENTED);
    expect([first.launches.count, second.launches.count]).toStrictEqual([1, 0]);
    expect(probed).toStrictEqual([JSON.stringify({ binary, userAgent: HEADED_AGENT })]);
  });

  it("remembers a binary that shows no token without launching it again", async () => {
    const { driver, launches } = counted(scriptedDriver(() => readingOf(HEADED_AGENT)));
    const reader = readerWith(driver);

    await expect(reader(binary)).resolves.toBeUndefined();
    await expect(readerWith(driver)(binary)).resolves.toBeUndefined();
    expect(launches.count).toBe(1);
  });

  it("keeps a failed read for 60 s, in this reader and the next, then reads again", async () => {
    const failing = counted(failingDriver());
    const working = counted(scriptedDriver(() => readingOf(HEADLESS_AGENT)));

    await expect(readerWith(failing.driver)(binary)).resolves.toBeUndefined();
    await expect(readerWith(working.driver)(binary)).resolves.toBeUndefined();
    now += FAILED_TTL_MS;
    await expect(readerWith(working.driver)(binary)).resolves.toStrictEqual(PRESENTED);
    expect([failing.launches.count, working.launches.count]).toStrictEqual([1, 1]);
    expect(probed).toStrictEqual([
      JSON.stringify({ binary, reason: "Chrome would not start.", userAgent: null }),
      JSON.stringify({ binary, userAgent: HEADED_AGENT }),
    ]);
  });

  it("reads again a day after it learned, and as soon as the binary changes", async () => {
    const { driver, launches } = counted(scriptedDriver(() => readingOf(HEADLESS_AGENT)));
    const reader = readerWith(driver);

    await reader(binary);
    now += LEARNED_TTL_MS;
    await reader(binary);
    await utimes(binary, new Date(), new Date(Date.now() + 60_000));
    await reader(binary);
    expect(launches.count).toBe(3);
  });
});

describe("hostCapabilities headless user agent", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "xrio-capabilities-agent-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const probeWith = (driver: BrowserDriver) =>
    createCapabilityProbe({
      driver,
      onlineCpusFile: path.join(root, "no-online"),
      processStatusFile: path.join(root, "no-status"),
      renderNodeDirectory: path.join(root, "no-render-nodes"),
      root: path.join(root, "scratch"),
    });

  it("presents headed Chrome's user agent only for a headless launch of a binary that shows the token", async () => {
    const launched: string[] = [];
    const scripted = scriptedDriver(() => readingOf(HEADLESS_AGENT));

    const probe = probeWith({
      launch: async (plan, ...rest) => {
        launched.push(plan.executable);

        return await scripted.launch(plan, ...rest);
      },
    });

    const stock = path.join(root, "chrome");

    await writeFile(stock, "");

    const [headed, unstated, headless] = await Promise.all([
      probe(stock, undefined, "headed"),
      probe(stock),
      probe(stock, undefined, "headless"),
    ]);

    expect({
      headed: headed.headlessUserAgent,
      headless: headless.headlessUserAgent,
      launched,
      unstated: unstated.headlessUserAgent,
    }).toStrictEqual({
      headed: undefined,
      headless: PRESENTED,
      launched: [stock],
      unstated: undefined,
    });
  });

  it("stores a stock answer into an empty host cache that the kit's probe then accepts", async () => {
    const host = path.join(root, "host");
    const stock = path.join(root, "chrome");

    await writeFile(stock, "");

    const kitBinary = await fakeForkPath("kit", { root });

    const probe = createCapabilityProbe({
      driver: scriptedDriver(() => readingOf(HEADLESS_AGENT)),
      onlineCpusFile: path.join(root, "no-online"),
      processStatusFile: path.join(root, "no-status"),
      renderNodeDirectory: path.join(root, "no-render-nodes"),
      root: host,
      scratchRoot: path.join(root, "scratch"),
    });

    const seen = await underUserPrivateGroupUmask(async () => {
      const headless = await probe(stock, undefined, "headless");
      const hostMode = await permissionsOf(host);
      const kit = await probe(kitBinary, undefined, "headless");

      return {
        agent: headless.headlessUserAgent,
        hostMode,
        knob: kit.fork?.knobs["suppress-headless-token"],
      };
    });

    expect(seen).toStrictEqual({
      agent: PRESENTED,
      hostMode: "700",
      knob: { origin: "def", value: "true" },
    });
  });

  it("launches nothing for the kit, which drops the token itself", async () => {
    const launched: string[] = [];

    const probe = probeWith({
      launch: async (plan) => {
        launched.push(plan.executable);

        return await Promise.reject(new Error("The kit needs no user agent probe."));
      },
    });

    const kit = await probe(await fakeForkPath("kit", { root }), undefined, "headless");

    expect({
      agent: kit.headlessUserAgent,
      knob: kit.fork?.knobs["suppress-headless-token"],
    }).toStrictEqual({
      agent: undefined,
      knob: { origin: "def", value: "true" },
    });
    expect(launched).toStrictEqual([]);
  });
});
