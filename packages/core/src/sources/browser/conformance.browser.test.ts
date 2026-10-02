import { spawn } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { text } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { chromePath } from "../../testing/chrome-path.ts";
import { busyPageStarted, conformancePages } from "../../testing/conformance-pages.ts";
import { DRIVERS } from "../../testing/drivers.ts";
import type { DriverName } from "../../testing/drivers.ts";
import { startFixtureServer } from "../../testing/fixture-server.ts";
import type { FixtureServer } from "../../testing/fixture-server.ts";
import { lastLaunchedPid, leftovers, nothingLeft } from "../../testing/leftovers.ts";
import { commandLineOf, killRenderers, noProcessUses, profileOf } from "../../testing/processes.ts";
import type { SourceDocument } from "../../types.ts";
import { scratchRoot, sweepAbandonedScratch } from "./browser-process.ts";
import { createBrowsers } from "./browsers.ts";
import { planLaunch } from "./launch-plan.ts";

const SCRAPE_CHILD = fileURLToPath(new URL("../../testing/scrape-child.ts", import.meta.url));

const PARENT_DEATH_BUDGET_MS = 5000;

const POLL_MS = 50;

const ABANDONED_LONG_AGO_MS = 2 * 60 * 60 * 1000;

const BUSY_TIMEOUT_MS = 5000;

const MARKER = /<meta name="xrio-page" content="(?<marker>[^"]+)"/u;

const PROBE =
  /<output id="probe" data-webdriver="(?<webdriver>\w+)" data-focus="(?<focus>\w+)" data-visibility="(?<visibility>\w+)"/u;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const KNOWN_PATCHRIGHT_COMMANDS = new Set([
  "browser Browser.getVersion",
  "browser Browser.setDownloadBehavior",
  "browser Target.attachToBrowserTarget",
  "browser Target.attachToTarget",
  "browser Target.detachFromTarget",
  "browser Target.getTargetInfo",
  "browser Target.setAutoAttach",
  "browser>page Network.enable",
  "browser>page Page.enable",
  "browser>page Page.getFrameTree",
  "browser>page Page.setLifecycleEventsEnabled",
  "page DOM.getDocument",
  "page DOM.getFrameOwner",
  "page DOM.querySelectorAll",
  "page Emulation.setEmulatedMedia",
  "page Emulation.setFocusEmulationEnabled",
  "page Fetch.continueRequest",
  "page Fetch.enable",
  "page Fetch.failRequest",
  "page Log.enable",
  "page Network.enable",
  "page Network.setCacheDisabled",
  "page Page.addScriptToEvaluateOnNewDocument",
  "page Page.createIsolatedWorld",
  "page Page.enable",
  "page Page.getFrameTree",
  "page Page.navigate",
  "page Page.setFontFamilies",
  "page Page.setLifecycleEventsEnabled",
  "page Runtime.callFunctionOn",
  "page Runtime.evaluate",
  "page Runtime.runIfWaitingForDebugger",
  "page Target.setAutoAttach",
]);

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

const isLaunchLine = (value: unknown): value is { launched: number } =>
  typeof value === "object" &&
  value !== null &&
  "launched" in value &&
  typeof value.launched === "number";

const SENT = /pw:protocol SEND ► \{"id":-?\d+,"method":"(?<method>[^"]+)"/u;

const ATTACHED =
  /pw:protocol ◀ RECV \{"method":"Target\.attachedToTarget","params":\{"sessionId":"(?<attached>[^"]+)","targetInfo":\{"targetId":"[^"]+","type":"(?<type>[^"]+)"/u;

const OUTER_SESSION = /,"sessionId":"(?<session>[^"]+)"\}$/u;

const ADAPTER_SESSIONS = new Set(["browser", "page", "browser>page"]);

const sentCommands = (trace: string): string[] => {
  const sessions = new Map<string, string>();
  const commands = new Set<string>();

  for (const line of trace.split("\n")) {
    const outer = OUTER_SESSION.exec(line)?.groups?.session;
    const session = outer === undefined ? "browser" : (sessions.get(outer) ?? "other");
    const attached = ATTACHED.exec(line)?.groups;
    const method = SENT.exec(line)?.groups?.method;

    if (attached?.attached !== undefined) {
      const type = attached.type ?? "other";

      sessions.set(attached.attached, outer === undefined ? type : `${session}>${type}`);
    }

    if (method !== undefined && ADAPTER_SESSIONS.has(session)) {
      commands.add(`${session} ${method}`);
    }
  }

  return [...commands].toSorted();
};

const SETTLE_SLACK_MS = 500;

const SCRAPE_STAGES = new Set(["queue", "launch", "navigation", "capture"]);

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

const runChildScrape = (
  driver: DriverName,
  mode: "headless" | "headed",
  url: string,
  env: NodeJS.ProcessEnv = {},
) =>
  spawn(process.execPath, [SCRAPE_CHILD, mode, chromePath(), url, driver], {
    env: { ...process.env, ...env },
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

const MODES = ["headless", "headed"] as const;

type Mode = (typeof MODES)[number];

const DRIVERS_UNDER_TEST = [
  { driver: "cdp", probe: { visibility: "visible", webdriver: "false" } },
  { driver: "patchright", probe: { focus: "true", visibility: "visible", webdriver: "false" } },
] as const satisfies readonly { driver: DriverName; probe: Readonly<Record<string, string>> }[];

const RUNS = DRIVERS_UNDER_TEST.flatMap((driver) => MODES.map((mode) => ({ ...driver, mode })));

const DRIVER_RUNS = RUNS.map(({ driver, mode }) => ({ driver, mode }));

let server: FixtureServer;

const load = async (
  driver: DriverName,
  mode: Mode,
  route: string,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<SourceDocument> => {
  const browsers = createBrowsers(DRIVERS[driver], 1);
  using deadline = startDeadline(timeoutMs, signal);

  try {
    return await browsers.load({
      browserPath: chromePath(),
      deadline,
      mode,
      proxy: undefined,
      url: new URL(route, server.origin),
    });
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
      await load("cdp", mode, route);
    }
  } finally {
    unsubscribe("xrio:cdp-command", record);
  }

  return [...sent].toSorted();
};

const probed = (html: string, keys: readonly string[]) => {
  const groups = PROBE.exec(html)?.groups ?? {};

  return Object.fromEntries(keys.map((key) => [key, groups[key]]));
};

describe.each(RUNS)("documents captured on $driver, $mode", ({ driver, mode, probe }) => {
  serveFixturePages();

  it.each(capturedPages)(
    "binds $path's response to the document it captured",
    async ({ landsOn, path: route }) => {
      const document = await load(driver, mode, route);
      const marker = markerOf(document.html) ?? "";

      expect(landsOn).toContain(marker);
      expect(document).toMatchObject({
        cookies: [`${marker}=1; Path=/`],
        headers: { "x-page": marker },
        status: 200,
      });
      expect(pathOf(document.url)).toBe(marker === "landing" ? "/landing" : `/${marker}`);
      expect(probed(document.html, Object.keys(probe))).toStrictEqual(probe);
      await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
    },
  );

  it("sends cookies set on each redirect hop to the next", async () => {
    const document = await load(driver, mode, "/redirect/1");

    expect(document.html).toContain('<p id="sent-cookies">hop1=1; hop2=1</p>');
    expect(document.requestUrls.map(pathOf).filter((visited) => visited !== FAVICON)).toStrictEqual(
      ["/redirect/1", "/redirect/2", "/landing"],
    );
  });

  it("logs requests from cross-origin frames and workers, but not from Chrome's own extensions", async () => {
    const framed = await load(driver, mode, "/iframe");
    const worker = await load(driver, mode, "/worker");

    expect(framed.requestUrls).toContain(`${server.crossOrigin}/framed`);
    expect(framed.requestUrls).toContain(`${server.crossOrigin}/framed-pixel`);
    expect(worker.requestUrls).toStrictEqual(
      expect.arrayContaining([`${server.origin}/worker.js`, `${server.origin}/from-worker`]),
    );
    expect(
      [...framed.requestUrls, ...worker.requestUrls].filter((url) => !url.startsWith("http")),
    ).toStrictEqual([]);
  });

  it("returns a 401 with WWW-Authenticate as data", async () => {
    const document = await load(driver, mode, "/basic-auth");

    expect(document).toMatchObject({ headers: { "x-page": "basic-auth" }, status: 401 });
    expect(markerOf(document.html)).toBe("basic-auth");
  });

  it("reads pages under a strict CSP, in legacy charsets and as XHTML", async () => {
    const strict = await load(driver, mode, "/strict-csp");
    const legacy = await load(driver, mode, "/legacy-charset");
    const xhtml = await load(driver, mode, "/xhtml");

    expect(markerOf(strict.html)).toBe("strict-csp");
    expect(legacy.html).toContain('<p id="text">Привет</p>');
    expect(xhtml).toMatchObject({ headers: { "x-page": "xhtml" }, status: 200 });
    expect(markerOf(xhtml.html.replace("/>", ">"))).toBe("xhtml");
  });

  it("captures Chrome's viewers for JSON, XML and PDF until Phase 4 gates them", async () => {
    const [json, xml, pdf] = [
      await load(driver, mode, "/json"),
      await load(driver, mode, "/xml"),
      await load(driver, mode, "/pdf"),
    ];

    expect(json.html).toContain('<pre>{"page":"json"}</pre>');
    expect(xml.html).toContain("xml-viewer-style");
    expect(pdf.html).toContain("pdf_embedder.css");
    expect([json.status, xml.status, pdf.status]).toStrictEqual([200, 200, 200]);
  });
});

describe.each(DRIVER_RUNS)("browser lifecycle on $driver, $mode", ({ driver, mode }) => {
  serveFixturePages();

  it.each(["/download", "/no-content"])("reports %s as an aborted navigation", async (route) => {
    await expect(load(driver, mode, route)).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      details: { netError: "net::ERR_ABORTED" },
    });
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("times out a capture the page never answers, and leaves nothing behind", async () => {
    using stages = recordStages();

    await expect(load(driver, mode, "/busy", BUSY_TIMEOUT_MS)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect([...stages.timings.keys()]).toContain("capture");
    expect(timeUntilSettled(stages.timings)).toBeLessThan(BUSY_TIMEOUT_MS + SETTLE_SLACK_MS);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("launches Chrome with exactly the planned argv", async () => {
    const controller = new AbortController();
    const loading = load(driver, mode, "/busy", 20_000, controller.signal);

    await busyPageStarted();
    const pid = lastLaunchedPid() ?? 0;
    const [commandLine, profile] = await Promise.all([commandLineOf(pid), profileOf(pid)]);

    const { args } = planLaunch({
      browserPath: chromePath(),
      display: process.env.DISPLAY,
      headless: mode === "headless",
      platform: process.platform,
      scratchDir: path.dirname(profile ?? ""),
      timezone: process.env.TZ,
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

  it("stops on a caller abort without installing signal handlers", async () => {
    const before = SIGNALS.map((signal) => process.listenerCount(signal));
    const controller = new AbortController();
    const reason = new Error("Stopped by caller");
    const loading = load(driver, mode, "/busy", 20_000, controller.signal);

    await busyPageStarted();
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toStrictEqual(before);
    controller.abort(reason);
    await expect(loading).rejects.toBe(reason);
    expect(SIGNALS.map((signal) => process.listenerCount(signal))).toStrictEqual(before);
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("reports a renderer that dies mid-capture as BROWSER_CRASHED", async () => {
    using stages = recordStages();
    const loading = load(driver, mode, "/busy");

    await stages.ended("navigation");
    const profile = await profileOf(lastLaunchedPid() ?? 0);

    await expect(killRenderers(profile ?? "unknown profile")).resolves.toBeGreaterThan(0);
    await expect(loading).rejects.toMatchObject({ code: "BROWSER_CRASHED" });
    expect([...stages.timings.keys()]).toContain("capture");
    await expect(leftovers()).resolves.toStrictEqual(nothingLeft);
  });

  it("leaves no Chrome process when its Node owner is killed, and the sweep removes its directory", async () => {
    const child = runChildScrape(driver, mode, `${server.origin}/busy`);
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

describe.each(MODES)("commands Patchright sends, %s", (mode) => {
  serveFixturePages();

  it("sends Chrome only the commands in the known Patchright set", async () => {
    const child = runChildScrape("patchright", mode, `${server.origin}/static`, {
      DEBUG: "pw:protocol",
    });

    const [trace, output] = await Promise.all([
      text(child.stderr),
      text(child.stdout),
      once(child, "exit"),
    ]);

    expect(child.exitCode).toBe(0);
    expect(output).toContain('{"status":200}');
    expect(
      sentCommands(trace).filter((command) => !KNOWN_PATCHRIGHT_COMMANDS.has(command)),
    ).toStrictEqual([]);
    expect(sentCommands(trace)).toContain("browser>page Page.setLifecycleEventsEnabled");
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
