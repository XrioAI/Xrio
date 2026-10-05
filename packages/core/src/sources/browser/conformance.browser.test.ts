import { spawn } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import { knobOf } from "../../humanizer/contracts.ts";
import { readHostZone } from "../../humanizer/host-zone.ts";
import { planIdentity } from "../../humanizer/humanizer.ts";
import type { IdentityIntent } from "../../humanizer/intent.ts";
import type { SurfaceChoices } from "../../humanizer/surfaces.ts";
import { chromePath } from "../../testing/chrome-path.ts";
import {
  busyPageStarted,
  conformancePages,
  wasRequested,
} from "../../testing/conformance-pages.ts";
import { fixedDevice, fixedRandom, fixedSeed } from "../../testing/fixed-seed.ts";
import { startFixtureServer } from "../../testing/fixture-server.ts";
import type { FixtureServer } from "../../testing/fixture-server.ts";
import { lastLaunchedPid, leftovers, nothingLeft } from "../../testing/leftovers.ts";
import { noPins } from "../../testing/no-pins.ts";
import { plannedScrapes } from "../../testing/planned-scrapes.ts";
import type { PlannedScrapes } from "../../testing/planned-scrapes.ts";
import { commandLineOf, killRenderers, noProcessUses, profileOf } from "../../testing/processes.ts";
import type { SourceDocument } from "../../types.ts";
import {
  createScratchDir,
  prepareProfile,
  removeScratchDir,
  scratchRoot,
  sweepAbandonedScratch,
} from "./browser-process.ts";
import { createCapabilityProbe } from "./capabilities.ts";
import { cdpDriver } from "./cdp/driver.ts";
import { killProcessGroup, waitForGroupExit } from "./group-lifetime.ts";
import { planLaunch } from "./launch-plan.ts";
import { CLOSE_BUDGET_MS } from "./port.ts";
import type { DriverBrowser } from "./port.ts";
import { renderDocument } from "./render.ts";

const SCRAPE_CHILD = fileURLToPath(new URL("../../testing/scrape-child.ts", import.meta.url));

const PARENT_DEATH_BUDGET_MS = 5000;

const POLL_MS = 50;

const ABANDONED_LONG_AGO_MS = 2 * 60 * 60 * 1000;

const BUSY_TIMEOUT_MS = 5000;

const DOWNLOAD_TEARDOWN_BOUND_MS = 1000;

const WATCH_SETTLE_MS = 300;

const MARKER = /<meta name="xrio-page" content="(?<marker>[^"]+)"/u;

const PROBE =
  /<output id="probe" data-webdriver="(?<webdriver>\w+)" data-focus="(?<focus>\w+)" data-visibility="(?<visibility>\w+)"/u;

const IDENTITY_REPORT = /<pre id="identity">(?<report>[^<]*)<\/pre>/u;

const MEDIA_REPORT = /<pre id="media">(?<report>[^<]*)<\/pre>/u;

const RESPONSIVE = /<p id="layout">(?<layout>[a-z]+)<\/p>/u;

const pageReportOf = ({ screen, window }: SurfaceChoices) =>
  screen.source === "host" || !("x" in window)
    ? { screen: screen.source, window: window.source }
    : {
        screen: {
          availHeight: screen.size.height - screen.workArea.top - screen.workArea.bottom,
          availLeft: screen.workArea.left,
          availTop: screen.workArea.top,
          availWidth: screen.size.width - screen.workArea.left - screen.workArea.right,
          height: screen.size.height,
          width: screen.size.width,
        },
        window: {
          innerWidth: window.width,
          outerHeight: window.height,
          outerWidth: window.width,
          screenX: window.x,
          screenY: window.y,
        },
      };

const seeded =
  (seed: string): (() => Uint8Array) =>
  () =>
    Buffer.from(seed, "hex");

const INTL_LOCALE = /"intlLocale":"(?<locale>[^"]*)"/u;

const ACCEPT_LANGUAGE = /<meta name="request-accept-language" content="(?<header>[^"]*)">/u;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const capturedPages = [
  { landsOn: ["static"], path: "/static" },
  { landsOn: ["landing"], path: "/redirect/1" },
  { landsOn: ["meta-refresh", "static"], path: "/meta-refresh" },
  { landsOn: ["js-redirect", "static"], path: "/js-redirect" },
  { landsOn: ["push-state"], path: "/push-state" },
  { landsOn: ["iframe"], path: "/iframe" },
  { landsOn: ["worker"], path: "/worker" },
  { landsOn: ["hanging-subresource"], path: "/hanging-subresource" },
  { landsOn: ["huge"], path: "/huge" },
  { landsOn: ["alert"], path: "/alert" },
];

const STATIC_PAGE_COMMANDS = [
  "browser Browser.close",
  "browser Browser.getVersion",
  "browser Browser.setDownloadBehavior",
  "browser Target.setAutoAttach",
  "main Network.enable",
  "main Page.bringToFront",
  "main Page.createIsolatedWorld",
  "main Page.enable",
  "main Page.navigate",
  "main Page.setLifecycleEventsEnabled",
  "main Runtime.evaluate",
  "main Runtime.runIfWaitingForDebugger",
  "main Target.setAutoAttach",
];

const ALLOWED_PAIRS = new Set([
  "browser Browser.close",
  "browser Browser.getVersion",
  "browser Browser.setDownloadBehavior",
  "browser Target.setAutoAttach",
  "main Network.enable",
  "main Page.bringToFront",
  "main Page.createIsolatedWorld",
  "main Page.enable",
  "main Page.handleJavaScriptDialog",
  "main Page.navigate",
  "main Page.setLifecycleEventsEnabled",
  "main Runtime.evaluate",
  "main Runtime.runIfWaitingForDebugger",
  "main Target.setAutoAttach",
  "popup Network.enable",
  "popup Runtime.runIfWaitingForDebugger",
  "popup Target.setAutoAttach",
  "iframe Network.enable",
  "iframe Runtime.runIfWaitingForDebugger",
  "iframe Target.setAutoAttach",
  "worker Network.enable",
  "worker Runtime.runIfWaitingForDebugger",
  "worker Target.setAutoAttach",
  "service_worker Network.enable",
  "service_worker Runtime.runIfWaitingForDebugger",
  "shared_worker Network.enable",
  "shared_worker Runtime.runIfWaitingForDebugger",
  "other Network.enable",
  "other Runtime.runIfWaitingForDebugger",
]);

const FAVICON = "/favicon.ico";

const markerOf = (html: string): string | undefined => MARKER.exec(html)?.groups?.marker;

const pathOf = (url: string): string => new URL(url).pathname;

const minutesAheadOfUtc = (month: number): number =>
  0 - new Date(new Date().getFullYear(), month, 15).getTimezoneOffset();

const isLaunchLine = (value: unknown): value is { launched: number } =>
  typeof value === "object" &&
  value !== null &&
  "launched" in value &&
  typeof value.launched === "number";

const SETTLE_SLACK_MS = 500;

const SCRAPE_STAGES = new Set(["queue", "launch", "verify", "navigation", "capture"]);

const isStageTiming = (message: unknown): message is { stage: string; durationMs: number } =>
  typeof message === "object" &&
  message !== null &&
  "stage" in message &&
  typeof message.stage === "string" &&
  "durationMs" in message &&
  typeof message.durationMs === "number";

const timeUntilSettled = (timings: ReadonlyMap<string, number>): number => {
  let total = 0;

  for (const [stage, durationMs] of timings) {
    total += SCRAPE_STAGES.has(stage) ? durationMs : 0;
  }

  return total;
};

const recordStages = () => {
  const timings = new Map<string, number>();
  const waiters = new Map<string, () => void>();

  const record: ChannelListener = (message) => {
    if (isStageTiming(message)) {
      timings.set(message.stage, message.durationMs);
      waiters.get(message.stage)?.();
    }
  };

  subscribe("xrio:stage", record);

  return {
    [Symbol.dispose]: () => {
      unsubscribe("xrio:stage", record);
    },
    ended: async (stage: string): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<"ended">();

      waiters.set(stage, () => {
        resolve("ended");
      });

      if (timings.has(stage)) {
        resolve("ended");
      }

      await promise;
    },
    timings,
  };
};

const runChildScrape = (mode: "headless" | "headed", url: string) =>
  spawn(process.execPath, [SCRAPE_CHILD, mode, chromePath(), url], {
    stdio: ["ignore", "pipe", "pipe"],
  });

const waitUntil = async (condition: () => Promise<boolean>, budgetMs: number): Promise<boolean> => {
  const started = performance.now();

  while (performance.now() - started < budgetMs) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- polling the process table until the condition holds.
    if (await condition()) {
      return true;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- polling the process table until the condition holds.
    await delay(POLL_MS);
  }

  return await condition();
};

const ALL_MODES = ["headless", "headed"] as const;

type Mode = (typeof ALL_MODES)[number];

const REQUESTED_MODES = process.env.XRIO_TEST_MODES?.split(",");

const MODES = ALL_MODES.filter((mode) => REQUESTED_MODES?.includes(mode) ?? true);

if (MODES.length === 0) {
  throw new Error(
    `XRIO_TEST_MODES must name headless, headed or both, not "${process.env.XRIO_TEST_MODES}".`,
  );
}

const PROBE_EXPECTED = { visibility: "visible", webdriver: "false" } as const;

let server: FixtureServer;

const load = async (
  mode: Mode,
  route: string,
  timeoutMs = 20_000,
  signal?: AbortSignal,
  browserArgs: readonly string[] = [],
  pins: IdentityIntent = noPins,
  random: () => Uint8Array = fixedRandom,
): Promise<SourceDocument> => {
  const browsers = plannedScrapes(cdpDriver, 1, { random });
  using deadline = startDeadline(timeoutMs, signal);

  try {
    return await browsers.visit({
      browserArgs,
      browserPath: chromePath(),
      deadline,
      mode,
      pins,
      proxy: undefined,
      url: new URL(route, server.origin),
    }).document;
  } finally {
    await browsers.close();
  }
};

const serveFixturePages = () => {
  beforeAll(async () => {
    server = await startFixtureServer(conformancePages);
  });

  afterAll(async () => {
    await server[Symbol.asyncDispose]();
  });
};

const isSentCommand = (message: unknown): message is { scope: string; method: string } =>
  typeof message === "object" &&
  message !== null &&
  "scope" in message &&
  typeof message.scope === "string" &&
  "method" in message &&
  typeof message.method === "string";

const tappedCommands = async (mode: Mode, routes: readonly string[]): Promise<string[]> => {
  const sent = new Set<string>();

  const record: ChannelListener = (message) => {
    if (isSentCommand(message)) {
      sent.add(`${message.scope} ${message.method}`);
    }
  };

  subscribe("xrio:cdp-command", record);

  try {
    for (const route of routes) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await load(mode, route);
    }
  } finally {
    unsubscribe("xrio:cdp-command", record);
  }

  return [...sent].toSorted();
};

const isText = (value: unknown): value is string => typeof value === "string";

const NO_AFTER_CAPTURE_READ = async (): Promise<null> => await Promise.resolve(null);

const isNumber = (value: unknown): value is number => typeof value === "number";

const PLATFORM_READ =
  'navigator.userAgentData.getHighEntropyValues(["platform"]).then(({ platform }) => platform)';

const withBrowser = async <Result>(
  mode: Mode,
  run: (browser: DriverBrowser, deadline: Deadline) => Promise<Result>,
): Promise<Result> => {
  const scratch = await createScratchDir(Date.now());

  const plan = planLaunch({
    browserArgs: [],
    browserPath: chromePath(),
    display: process.env.DISPLAY,
    headless: mode === "headless",
    identity: planIdentity({
      capabilities: await createCapabilityProbe()(chromePath()),
      device: fixedDevice,
      exit: { facts: { kind: "unknown" }, route: "direct" },
      hostZone: readHostZone(),
      mode,
      pins: noPins,
    }).inputs,
    scratchDir: scratch.path,
    xauthority: process.env.XAUTHORITY,
  });

  using deadline = startDeadline(20_000);

  await prepareProfile(plan);
  let pid: number | undefined;

  const browser = await cdpDriver.launch(
    plan,
    deadline,
    (reported) => {
      pid = reported;
    },
    () => {},
  );

  try {
    return await run(browser, deadline);
  } finally {
    await browser.close(CLOSE_BUDGET_MS);

    if (pid !== undefined) {
      killProcessGroup(pid);
      await waitForGroupExit(pid, AbortSignal.timeout(5000));
    }

    await removeScratchDir(scratch);
  }
};

const probed = (html: string, keys: readonly string[]) => {
  const groups = PROBE.exec(html)?.groups ?? {};

  return Object.fromEntries(keys.map((key) => [key, groups[key]]));
};

describe.each(MODES)("documents captured, %s", (mode) => {
  serveFixturePages();

  it.each(capturedPages)(
    "binds $path's response to the document it captured",
    async ({ landsOn, path: route }) => {
      const document = await load(mode, route);
      const marker = markerOf(document.html) ?? "";

      expect(landsOn).toContain(marker);
      expect(document).toMatchObject({
        cookies: [`${marker}=1; Path=/`],
        headers: { "x-page": marker },
        status: 200,
      });
      expect(pathOf(document.url)).toBe(marker === "landing" ? "/landing" : `/${marker}`);
      expect(probed(document.html, Object.keys(PROBE_EXPECTED))).toStrictEqual(PROBE_EXPECTED);
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    },
  );

  it("reads the startup page before navigating, then captures the page it navigates to", async () => {
    await withBrowser(mode, async (browser, deadline) => {
      await expect(browser.evaluateIsolated("location.href", isText, deadline)).resolves.toBe(
        "about:blank",
      );

      const { source: document } = await renderDocument(
        browser,
        new URL("/static", server.origin),
        deadline,
        NO_AFTER_CAPTURE_READ,
      );

      expect(document).toMatchObject({ headers: { "x-page": "static" }, status: 200 });
      expect(markerOf(document.html)).toBe("static");
      expect(probed(document.html, Object.keys(PROBE_EXPECTED))).toStrictEqual(PROBE_EXPECTED);
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("awaits promises in isolated reads after a capture", async () => {
    await withBrowser(mode, async (browser, deadline) => {
      await renderDocument(
        browser,
        new URL("/static", server.origin),
        deadline,
        NO_AFTER_CAPTURE_READ,
      );

      await expect(
        browser.evaluateIsolated("Promise.resolve(42)", isNumber, deadline),
      ).resolves.toBe(42);
      await expect(browser.evaluateIsolated(PLATFORM_READ, isText, deadline)).resolves.toMatch(
        /\S/u,
      );
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reads the launch's languages, zone offsets, automation flag and infobar tell on /identity", async () => {
    const capabilities = await createCapabilityProbe()(chromePath());
    const { html, identity } = await load(mode, "/identity");

    const infobarShown =
      mode === "headed" && knobOf(capabilities, "suppress-startup-infobars") !== "true";

    const report: unknown = JSON.parse(IDENTITY_REPORT.exec(html)?.groups?.report ?? "null");

    expect(report).toMatchObject({
      language: "en-US",
      languages: ["en-US", "en"],
      offsets: { january: minutesAheadOfUtc(0), july: minutesAheadOfUtc(6) },
      webdriver: false,
      windowSizeWait: "settled",
    });
    expect(identity.tells.includes("flag-infobar")).toBe(infobarShown);
  });

  it.runIf(mode === "headless")(
    "reads the fixed seed's drawn screen, work area and maximized window on /identity",
    async () => {
      const { html } = await load(mode, "/identity");
      const report: unknown = JSON.parse(IDENTITY_REPORT.exec(html)?.groups?.report ?? "null");

      expect(report).toMatchObject({
        screen: {
          availHeight: 1018,
          availLeft: 0,
          availTop: 32,
          availWidth: 1680,
          colorDepth: 24,
          devicePixelRatio: 1,
          height: 1050,
          width: 1680,
        },
        window: { innerWidth: 1680, outerHeight: 1018, outerWidth: 1680, screenX: 0, screenY: 32 },
      });
    },
  );

  it("sends cookies set on each redirect hop to the next", async () => {
    const document = await load(mode, "/redirect/1");

    expect(document.html).toContain('<p id="sent-cookies">hop1=1; hop2=1</p>');
    expect(document.requestUrls.map(pathOf).filter((visited) => visited !== FAVICON)).toStrictEqual(
      ["/redirect/1", "/redirect/2", "/landing"],
    );
  });

  it("logs requests from cross-origin frames and workers, but not from Chrome's own extensions", async () => {
    const framed = await load(mode, "/iframe");
    const worker = await load(mode, "/worker");

    expect(framed.requestUrls).toContain(`${server.crossOrigin}/framed`);
    expect(framed.requestUrls).toContain(`${server.crossOrigin}/framed-pixel`);
    expect(worker.requestUrls).toStrictEqual(
      expect.arrayContaining([`${server.origin}/worker.js`, `${server.origin}/from-worker`]),
    );
    expect(
      [...framed.requestUrls, ...worker.requestUrls].filter((url) => !url.startsWith("http")),
    ).toStrictEqual([]);
  });

  it("logs requests from workers that nested workers make", async () => {
    const document = await load(mode, "/nested-worker");

    expect(document.requestUrls).toStrictEqual(
      expect.arrayContaining([`${server.origin}/outer-worker.js`, `${server.origin}/from-nested`]),
    );
  });

  it("returns a 401 with WWW-Authenticate as data", async () => {
    const document = await load(mode, "/basic-auth");

    expect(document).toMatchObject({ headers: { "x-page": "basic-auth" }, status: 401 });
    expect(markerOf(document.html)).toBe("basic-auth");
  });

  it("captures a page over 4 Mi code units in slices, whole", async () => {
    const document = await load(mode, "/sliced");

    expect(document.html).toHaveLength(4_194_432);
    expect(document.html.endsWith('<p id="last">sliced-end</p></body></html>')).toBeTruthy();
  });

  it("refuses a page over 32 Mi code units as too large", async () => {
    await expect(load(mode, "/too-large")).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it.each(["/redirect-to-closed-port", "/replace-with-blank"])(
    "fails %s, which commits a document with no response, as a network error",
    async (route) => {
      await expect(load(mode, route)).rejects.toMatchObject({
        code: "NETWORK_ERROR",
        message: "The page committed a document that had no HTTP response.",
      });
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    },
  );

  it("returns a 403 with an empty body as data", async () => {
    const document = await load(mode, "/empty-403");

    expect(document).toMatchObject({
      cookies: ["empty-403=1; Path=/"],
      headers: { "x-page": "empty-403" },
      status: 403,
    });
  });

  it("reads pages under a strict CSP, in legacy charsets and as XHTML", async () => {
    const strict = await load(mode, "/strict-csp");
    const legacy = await load(mode, "/legacy-charset");
    const xhtml = await load(mode, "/xhtml");

    expect(markerOf(strict.html)).toBe("strict-csp");
    expect(legacy.html).toContain('<p id="text">Привет</p>');
    expect(xhtml).toMatchObject({ headers: { "x-page": "xhtml" }, status: 200 });
    expect(markerOf(xhtml.html.replace("/>", ">"))).toBe("xhtml");
  });

  it("captures Chrome's viewers for JSON, XML and PDF until Phase 4 gates them", async () => {
    const [json, xml, pdf] = [
      await load(mode, "/json"),
      await load(mode, "/xml"),
      await load(mode, "/pdf"),
    ];

    expect(json.html).toContain('<pre>{"page":"json"}</pre>');
    expect(xml.html).toContain("xml-viewer-style");
    expect(pdf.html).toContain("pdf_embedder.css");
    expect([json.status, xml.status, pdf.status]).toStrictEqual([200, 200, 200]);
  });
});

describe.each(MODES)("the launch identity, %s", (mode) => {
  serveFixturePages();

  it("reads the secure-context surfaces after capture on a loopback page", async () => {
    const { identity } = await load(mode, "/identity");

    expect(identity).toMatchObject({
      coverage: {
        battery: { state: "observed" },
        clientHints: { state: "observed" },
        deviceMemory: { state: "observed" },
        webgpu: { state: "observed" },
      },
    });
    expect(identity).toMatchObject({ observed: { clientHints: { bitness: "64" } } });
  });

  it.each([
    {
      header: "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      languages: ["de-DE", "de", "en-US", "en"],
      tag: "de-DE",
    },
    {
      header: "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      languages: ["pt-BR", "pt", "en-US", "en"],
      tag: "pt-BR",
    },
    { header: "en-AU,en-US;q=0.9,en;q=0.8", languages: ["en-AU", "en-US", "en"], tag: "en-AU" },
  ])(
    "presents the pinned $tag in the page, the Intl language and the request header",
    async ({ header, languages, tag }) => {
      const { html, identity } = await load(mode, "/identity", 20_000, undefined, [], {
        ...noPins,
        locale: tag,
      });

      const reportText = IDENTITY_REPORT.exec(html)?.groups?.report ?? "null";
      const report: unknown = JSON.parse(reportText);
      const intlLanguage = process.platform === "linux" ? tag.slice(0, 2) : "";

      expect(report).toMatchObject({ language: languages[0], languages });
      expect(
        (INTL_LOCALE.exec(reportText)?.groups?.locale ?? "").startsWith(intlLanguage),
      ).toBeTruthy();
      expect(ACCEPT_LANGUAGE.exec(html)?.groups?.header).toBe(header);
      expect(identity).toMatchObject({
        surfaces: { locale: { languages, tag } },
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "lists one unlabelled microphone and speaker and no camera on Linux, with no permission granted",
    async () => {
      const { html } = await load(mode, "/media");
      const report: unknown = JSON.parse(MEDIA_REPORT.exec(html)?.groups?.report ?? "null");

      expect(report).toStrictEqual({
        kinds: { audioinput: 1, audiooutput: 1 },
        named: [],
        permissions: { camera: "prompt", microphone: "prompt" },
        requests:
          mode === "headless"
            ? { audio: "NotAllowedError", video: "NotFoundError" }
            : { audio: "pending", video: "pending" },
      });
    },
  );

  it("reads after capture in an isolated world, out of reach of the page's own wrappers", async () => {
    const { identity } = await load(mode, "/watch");

    await delay(WATCH_SETTLE_MS);
    expect({ identity, seen: wasRequested("/watch-seen") }).toMatchObject({
      identity: { coverage: { clientHints: { state: "observed" } } },
      seen: false,
    });
  });

  it("lets the same wrappers see the production read when it runs in the main world", async () => {
    await load(mode, "/watch-control");

    await vi.waitFor(() => {
      expect(wasRequested("/watch-seen")).toBeTruthy();
    });
  });

  it("presents a pinned timezone on /identity, whatever the host's zone", async () => {
    const browsers = plannedScrapes(cdpDriver, 1);
    using deadline = startDeadline(20_000);

    try {
      const { html } = await browsers.visit({
        browserArgs: [],
        browserPath: chromePath(),
        deadline,
        mode,
        pins: { ...noPins, timezone: "Australia/Adelaide" },
        proxy: undefined,
        url: new URL("/identity", server.origin),
      }).document;

      const report: unknown = JSON.parse(IDENTITY_REPORT.exec(html)?.groups?.report ?? "null");

      expect(report).toMatchObject({
        offsets: { january: 630, july: 570 },
        timeZone: "Australia/Adelaide",
      });
    } finally {
      await browsers.close();
    }
  });
});

describe.each(MODES)("the drawn device, %s", (mode) => {
  serveFixturePages();

  it.runIf(mode === "headless").each([
    { layout: "gnome", seed: fixedSeed, window: "maximized" },
    { layout: "ubuntu", seed: "0000000000000028", window: "floating" },
    { layout: "kde", seed: "0000000000000005", window: "maximized" },
    { layout: "cinnamon", seed: "00000000000000a1", window: "maximized" },
  ])(
    "presents $seed's $layout screen and $window window exactly, at least 1265 px wide",
    async ({ layout, seed, window }) => {
      const { html, identity } = await load(
        mode,
        "/identity",
        20_000,
        undefined,
        [],
        noPins,
        seeded(seed),
      );

      const report: unknown = JSON.parse(IDENTITY_REPORT.exec(html)?.groups?.report ?? "null");

      expect(identity).toMatchObject({
        notes: [],
        surfaces: { screen: { layout }, window: { kind: window } },
      });
      expect(report).toMatchObject(
        identity.mode === "http" ? { mode: "http" } : pageReportOf(identity.surfaces),
      );

      const drawnWidth =
        identity.mode === "http" || !("width" in identity.surfaces.window)
          ? 0
          : identity.surfaces.window.width;

      expect(drawnWidth).toBeGreaterThanOrEqual(1265);
    },
  );

  it.runIf(mode === "headless")(
    "presents a pinned 1440x900 screen with a 48 px bottom taskbar and a maximized window",
    async () => {
      const display = {
        screens: [{ height: 900, weight: 1, width: 1440 }],
        taskbars: [{ bottom: 48, left: 0, right: 0, top: 0, weight: 1 }],
        windows: [{ kind: "maximized", weight: 1 }],
      } as const;

      const { html } = await load(mode, "/identity", 20_000, undefined, [], {
        ...noPins,
        display,
      });

      const report: unknown = JSON.parse(IDENTITY_REPORT.exec(html)?.groups?.report ?? "null");

      expect(report).toMatchObject({
        screen: { availHeight: 852, availTop: 0, availWidth: 1440, height: 900, width: 1440 },
        window: { outerHeight: 852, outerWidth: 1440, screenX: 0, screenY: 0 },
      });
    },
  );

  it.each([fixedSeed, "0000000000000028", "0000000000000005"])(
    "serves the desktop layout to a 1200 px media query under seed %s",
    async (seed) => {
      const { html } = await load(mode, "/responsive", 20_000, undefined, [], noPins, seeded(seed));

      expect(RESPONSIVE.exec(html)?.groups?.layout).toBe("desktop");
    },
  );
});

describe.each(MODES)("browser lifecycle, %s", (mode) => {
  serveFixturePages();

  it.each(["/download", "/no-content"])("reports %s as an aborted navigation", async (route) => {
    await expect(load(mode, route)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      details: { netError: "net::ERR_ABORTED" },
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("times out a capture the page never answers, and leaves nothing behind", async () => {
    using stages = recordStages();

    await expect(load(mode, "/busy", BUSY_TIMEOUT_MS)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect([...stages.timings.keys()]).toContain("capture");
    expect(timeUntilSettled(stages.timings)).toBeLessThan(BUSY_TIMEOUT_MS + SETTLE_SLACK_MS);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("launches Chrome with exactly the planned argv", async () => {
    const controller = new AbortController();
    const loading = load(mode, "/busy", 20_000, controller.signal);

    await busyPageStarted();
    const pid = lastLaunchedPid() ?? 0;
    const [commandLine, profile] = await Promise.all([commandLineOf(pid), profileOf(pid)]);

    const { args } = planLaunch({
      browserArgs: [],
      browserPath: chromePath(),
      display: process.env.DISPLAY,
      headless: mode === "headless",
      identity: planIdentity({
        capabilities: await createCapabilityProbe()(chromePath()),
        device: fixedDevice,
        exit: { facts: { kind: "unknown" }, route: "direct" },
        hostZone: readHostZone(),
        mode,
        pins: noPins,
      }).inputs,
      scratchDir: path.dirname(profile ?? ""),
      xauthority: process.env.XAUTHORITY,
    });

    controller.abort(new Error("argv checked"));
    await expect(loading).rejects.toThrow("argv checked");
    expect(args.filter((arg) => !commandLine.includes(arg))).toStrictEqual([]);
    expect(commandLine.split(" --").length - 1).toBe(
      args.filter((arg) => arg.startsWith("--")).length,
    );
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("launches Chrome with the client's switches once, after Xrio's own", async () => {
    const controller = new AbortController();
    const callerSwitches = ["--disable-gpu-compositing"];
    const loading = load(mode, "/busy", 20_000, controller.signal, callerSwitches);

    await busyPageStarted();
    const commandLine = await commandLineOf(lastLaunchedPid() ?? 0);

    controller.abort(new Error("argv checked"));
    await expect(loading).rejects.toThrow("argv checked");

    const caller = commandLine.indexOf("--disable-gpu-compositing");

    expect(commandLine.split("--disable-gpu-compositing")).toHaveLength(2);
    expect(commandLine.indexOf("--crash-dumps-dir=")).toBeLessThan(caller);
    expect(caller).toBeLessThan(commandLine.indexOf("--user-data-dir="));
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("stops on a caller abort without installing signal handlers", async () => {
    const before = SIGNALS.map((signal) => process.listenerCount(signal));
    const controller = new AbortController();
    const reason = new Error("Stopped by caller");
    const loading = load(mode, "/busy", 20_000, controller.signal);

    await busyPageStarted();
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toStrictEqual(before);
    controller.abort(reason);
    await expect(loading).rejects.toBe(reason);
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toStrictEqual(before);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reports a renderer that dies mid-capture as BROWSER_CRASHED", async () => {
    using stages = recordStages();
    const loading = load(mode, "/busy");

    await stages.ended("navigation");
    const profile = await profileOf(lastLaunchedPid() ?? 0);

    await expect(killRenderers(profile ?? "unknown profile")).resolves.toBeGreaterThan(0);
    await expect(loading).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
    expect([...stages.timings.keys()]).toContain("capture");
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("leaves no Chrome process when its Node owner is killed, and the sweep removes its directory", async () => {
    const child = runChildScrape(mode, `${server.origin}/busy`);
    const lines = createInterface({ input: child.stdout });

    const [launchLine] = await Promise.all([
      lines[Symbol.asyncIterator]().next(),
      busyPageStarted(),
    ]);

    const launch: unknown = JSON.parse(String(launchLine.value));

    const profile =
      (isLaunchLine(launch) ? await profileOf(launch.launched) : undefined) ?? "unknown profile";

    child.kill("SIGKILL");

    await expect(
      waitUntil(async () => await noProcessUses(path.dirname(profile)), PARENT_DEATH_BUDGET_MS),
    ).resolves.toBeTruthy();
    await expect(
      sweepAbandonedScratch(scratchRoot(), Date.now() + ABANDONED_LONG_AGO_MS),
    ).resolves.toContain(path.dirname(profile));
    expect(existsSync(profile)).toBeFalsy();
  });
});

describe.each(MODES)("downloads on our CDP client, %s", (mode) => {
  serveFixturePages();

  it("lets a denied download settle, so teardown finishes well within its budget", async () => {
    using stages = recordStages();

    await expect(load(mode, "/download")).rejects.toMatchObject({
      details: { netError: "net::ERR_ABORTED" },
    });
    expect(stages.timings.get("teardown")).toBeLessThan(DOWNLOAD_TEARDOWN_BOUND_MS);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });
});

describe.each(MODES)("commands our CDP client sends, %s", (mode) => {
  serveFixturePages();

  it("sends exactly the expected commands to load a static page", async () => {
    await expect(tappedCommands(mode, ["/static"])).resolves.toStrictEqual(STATIC_PAGE_COMMANDS);
  });

  it("sends only allowlisted commands to frames, workers and dialogs", async () => {
    const sent = await tappedCommands(mode, ["/static", "/iframe", "/worker", "/alert"]);

    expect(sent.filter((pair) => !ALLOWED_PAIRS.has(pair))).toStrictEqual([]);
    expect(sent).toStrictEqual(
      expect.arrayContaining([
        "iframe Runtime.runIfWaitingForDebugger",
        "main Page.handleJavaScriptDialog",
        "worker Runtime.runIfWaitingForDebugger",
      ]),
    );
  });
});

interface VisitFailure {
  name: string;
  route: string;
  error: object;
  browserPath?: string;
  timeoutMs?: number;
  interrupt?: "abort" | "kill-renderer";
}

type BrowserLoad = (request: Parameters<PlannedScrapes["visit"]>[0]) => Promise<SourceDocument>;

const visitFailures: VisitFailure[] = [
  {
    browserPath: "/nonexistent/chrome",
    error: { code: "BROWSER_LAUNCH_FAILED" },
    name: "a launch failure",
    route: "/static",
  },
  {
    error: { code: "NETWORK_ERROR", details: { netError: "net::ERR_ABORTED" } },
    name: "a download",
    route: "/download",
  },
  {
    error: { message: "Ownership lost" },
    interrupt: "abort",
    name: "an aborted signal",
    route: "/busy",
  },
  { error: { code: "TIMEOUT" }, name: "a timeout", route: "/busy", timeoutMs: BUSY_TIMEOUT_MS },
  {
    error: { code: "BROWSER_CRASHED" },
    interrupt: "kill-renderer",
    name: "a renderer killed mid-capture",
    route: "/busy",
  },
];

const interruptVisit = async (
  failure: VisitFailure,
  owner: AbortController,
  stages: ReturnType<typeof recordStages>,
): Promise<void> => {
  if (failure.interrupt === "abort") {
    await busyPageStarted();
    owner.abort(new Error("Ownership lost"));
  }

  if (failure.interrupt === "kill-renderer") {
    await stages.ended("navigation");
    await killRenderers((await profileOf(lastLaunchedPid() ?? 0)) ?? "unknown profile");
  }
};

const failOnce = async (
  mode: (typeof MODES)[number],
  failure: VisitFailure,
  loadWith: BrowserLoad,
): Promise<void> => {
  using stages = recordStages();
  using deadline = startDeadline(failure.timeoutMs ?? 20_000);
  const owner = new AbortController();

  const loading = loadWith({
    browserArgs: [],
    browserPath: failure.browserPath ?? chromePath(),
    deadline: deadline.boundTo(owner.signal),
    mode,
    pins: noPins,
    proxy: undefined,
    url: new URL(failure.route, server.origin),
  });

  await interruptVisit(failure, owner, stages);
  await expect(loading).rejects.toMatchObject(failure.error);
};

describe.each(MODES)("browser visits, %s", (mode) => {
  serveFixturePages();

  it.each(visitFailures)(
    "visit: $name closes only after Chrome is gone, then admits the next scrape",
    async (failure) => {
      const browsers = plannedScrapes(cdpDriver, 1);
      const closings: Promise<unknown>[] = [];

      await failOnce(mode, failure, async (request) => {
        const visit = browsers.visit(request);

        closings.push(visit.closed);

        return await visit.document;
      });

      await expect(Promise.all(closings)).resolves.toStrictEqual([{ exited: true }]);
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);

      await failOnce(mode, failure, async (request) => await browsers.visit(request).document);
      using deadline = startDeadline(20_000);

      const next = await browsers.visit({
        browserArgs: [],
        browserPath: chromePath(),
        deadline,
        mode,
        pins: noPins,
        proxy: undefined,
        url: new URL("/static", server.origin),
      }).document;

      await browsers.close();
      expect(markerOf(next.html)).toBe("static");
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    },
  );
});
