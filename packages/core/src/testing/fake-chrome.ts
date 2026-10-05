import { createWriteStream } from "node:fs";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const SCENARIOS = [
  "normal",
  "fragmented",
  "no-start",
  "old",
  "crash-on-navigate",
  "ignore-close",
  "slow-start",
  "navigate-during-capture",
  "commit-after-capture-error",
  "exit-after-capture-error",
  "pipe-closes-on-navigate",
  "startup-blank-commit",
  "evaluate-throws",
] as const;

type Scenario = (typeof SCENARIOS)[number];

interface Command {
  id: number;
  method: string;
  sessionId?: string;
  params?: unknown;
}

const SCENARIO_NAMES = new Set<string>(SCENARIOS);

const FRAGMENT_BYTES = 7;

const SLOW_START_MS = 30_000;

const AFTER_CAPTURE_ERROR_MS = 50;

const STARTUP_BLANK_MS = 100;

const BETWEEN_REPLY_AND_COMMIT_MS = 50;

const TARGET_ID = "T1";

const BROWSER_SESSION = "B1";

const INITIAL_LIFECYCLE = [
  "commit",
  "DOMContentLoaded",
  "load",
  "networkAlmostIdle",
  "networkIdle",
];

const PAGE_HTML = "<!DOCTYPE html><html><head></head><body><p>fake page</p></body></html>";

const isScenario = (value: string): value is Scenario => SCENARIO_NAMES.has(value);

const isCommand = (value: unknown): value is Command =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "number" &&
  "method" in value &&
  typeof value.method === "string" &&
  (!("sessionId" in value) || typeof value.sessionId === "string");

const readsByValue = (params: unknown): params is { awaitPromise: true; returnByValue: true } =>
  typeof params === "object" &&
  params !== null &&
  "returnByValue" in params &&
  params.returnByValue === true &&
  "awaitPromise" in params &&
  params.awaitPromise === true;

const hasUrl = (params: unknown): params is { url: string } =>
  typeof params === "object" &&
  params !== null &&
  "url" in params &&
  typeof params.url === "string";

const requested = process.env.XRIO_FAKE_SCENARIO ?? "normal";

const scenario: Scenario = isScenario(requested) ? requested : "normal";

const PRODUCT = scenario === "old" ? "HeadlessChrome/120.0.0.0" : "HeadlessChrome/154.0.8037.57";

const TARGET_NAVIGATED = { code: -32_000, message: "Inspected target navigated or closed" };

const FRAME_NOT_IN_TARGET = {
  code: -32_000,
  message: "Frame with the given id does not belong to the target.",
};

const output = createWriteStream("", { fd: 4 });

const input = new Socket({ fd: 3, readable: true }).setEncoding("utf-8");

const pageSessions: string[] = [];

let currentUrl = "about:blank";

let navigatedDuringCapture = false;

const writeFragmented = async (text: string): Promise<void> => {
  for (let start = 0; start < text.length; start += FRAGMENT_BYTES) {
    output.write(text.slice(start, start + FRAGMENT_BYTES));
    // oxlint-disable-next-line eslint/no-await-in-loop -- each fragment must reach the reader separately.
    await delay(1);
  }
};

let written: Promise<void> = Promise.resolve();

const write = async (messages: Json[]): Promise<void> => {
  const text = messages.map((message) => `${JSON.stringify(message)}\0`).join("");

  if (scenario !== "fragmented") {
    output.write(text);

    return;
  }

  const previous = written;

  written = (async () => {
    await previous;
    await writeFragmented(text);
  })();
  await written;
};

const pageTarget = (url: string): Json => ({
  attached: true,
  browserContextId: "C1",
  canAccessOpener: false,
  targetId: TARGET_ID,
  title: "",
  type: "page",
  url,
});

const frame = (loaderId: string, url: string): Json => ({
  crossOriginIsolatedContextType: "NotIsolated",
  domainAndRegistry: "",
  gatedAPIFeatures: [],
  id: TARGET_ID,
  loaderId,
  mimeType: "text/html",
  secureContextType: "Secure",
  securityOrigin: new URL(url).origin,
  url,
});

const onSession = (sessionId: string | undefined, message: { [key: string]: Json }): Json =>
  sessionId === undefined ? message : { ...message, sessionId };

const attachPage = (sessionId: string, parentSession?: string): Json => {
  pageSessions.push(sessionId);

  return onSession(parentSession, {
    method: "Target.attachedToTarget",
    params: { sessionId, targetInfo: pageTarget(currentUrl), waitingForDebugger: false },
  });
};

const onEveryPageSession = (method: string, params: Json): Json[] =>
  pageSessions.map((sessionId) => ({ method, params, sessionId }));

const navigationEvents = (url: string, loaderId = "L1"): Json[] => [
  ...onEveryPageSession("Network.requestWillBeSent", {
    documentURL: url,
    frameId: TARGET_ID,
    loaderId,
    request: { headers: {}, method: "GET", url },
    requestId: loaderId,
    type: "Document",
  }),
  ...onEveryPageSession("Network.responseReceivedExtraInfo", {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "a=1\nb=2",
      "X-Fake": "yes",
    },
    requestId: loaderId,
    statusCode: 200,
  }),
  ...onEveryPageSession("Network.responseReceived", {
    frameId: TARGET_ID,
    hasExtraInfo: true,
    loaderId,
    requestId: loaderId,
    response: { headers: { "Content-Type": "text/html" }, mimeType: "text/html", status: 200, url },
    type: "Document",
  }),
];

const commitEvents = (url: string, loaderId = "L1"): Json[] => [
  ...onEveryPageSession("Page.lifecycleEvent", {
    frameId: TARGET_ID,
    loaderId,
    name: "init",
    timestamp: 1,
  }),
  ...onEveryPageSession("Page.frameNavigated", { frame: frame(loaderId, url), type: "Navigation" }),
  ...onEveryPageSession("Page.lifecycleEvent", {
    frameId: TARGET_ID,
    loaderId,
    name: "DOMContentLoaded",
    timestamp: 2,
  }),
];

const CAPTURED_PAGE: Json = { result: { type: "string", value: PAGE_HTML } };

const THROWN: Json = {
  exceptionDetails: {
    columnNumber: 0,
    exception: { description: "Error: fake page failure", type: "object" },
    exceptionId: 1,
    lineNumber: 0,
    text: "Uncaught",
  },
  result: { type: "object" },
};

const UTILITY_SCRIPT: Json = {
  result: {
    className: "UtilityScript",
    description: "UtilityScript",
    objectId: "U1",
    type: "object",
  },
};

const fixedResults = new Map<string, Json>([
  [
    "DOM.getDocument",
    {
      root: {
        backendNodeId: 1,
        childNodeCount: 0,
        localName: "",
        nodeId: 1,
        nodeName: "#document",
        nodeType: 9,
        nodeValue: "",
      },
    },
  ],
  ["DOM.querySelectorAll", { nodeIds: [] }],
  ["Page.addScriptToEvaluateOnNewDocument", { identifier: "1" }],
  ["Page.createIsolatedWorld", { executionContextId: 5 }],
  [
    "Target.getTargetInfo",
    {
      targetInfo: {
        attached: true,
        canAccessOpener: false,
        targetId: "B0",
        title: "",
        type: "browser",
        url: "",
      },
    },
  ],
]);

const lifecycleReplay = (sessionId: string | undefined): Json[] =>
  INITIAL_LIFECYCLE.map((name, timestamp) =>
    onSession(sessionId, {
      method: "Page.lifecycleEvent",
      params: { frameId: TARGET_ID, loaderId: "L0", name, timestamp },
    }),
  );

const autoAttach = async (sessionId: string | undefined): Promise<Json[]> => {
  if (sessionId !== undefined) {
    return [];
  }

  if (scenario === "slow-start") {
    await delay(SLOW_START_MS);
  }

  return [attachPage("S1")];
};

const navigate = (url: string | undefined, committed: Json): Json[] => {
  if (scenario === "crash-on-navigate") {
    process.exit(1);
  }

  currentUrl = url ?? "about:blank";

  return [...navigationEvents(currentUrl), committed, ...commitEvents(currentUrl)];
};

const CAPTURE_ERROR_SCENARIOS = new Set<Scenario>([
  "navigate-during-capture",
  "commit-after-capture-error",
  "exit-after-capture-error",
]);

const startupBlankCommit = (): Json[] => [
  ...onEveryPageSession("Page.frameNavigated", {
    frame: frame("BLANK", "about:blank"),
    type: "Navigation",
  }),
  ...onEveryPageSession("Page.lifecycleEvent", {
    frameId: TARGET_ID,
    loaderId: "BLANK",
    name: "DOMContentLoaded",
    timestamp: 0,
  }),
];

const enablePage = async (enabled: Json): Promise<void> => {
  if (scenario !== "startup-blank-commit") {
    await write([enabled]);

    return;
  }

  await delay(STARTUP_BLANK_MS);
  await write([enabled, ...startupBlankCommit()]);
};

const answerNavigate = async (url: string | undefined, committed: Json): Promise<void> => {
  if (scenario === "pipe-closes-on-navigate") {
    input.destroy();
    output.destroy();
    await delay(SLOW_START_MS);

    return;
  }

  if (scenario !== "startup-blank-commit") {
    await write(navigate(url, committed));

    return;
  }

  currentUrl = url ?? "about:blank";
  await write([...navigationEvents(currentUrl), committed]);
  await delay(BETWEEN_REPLY_AND_COMMIT_MS);
  await write(commitEvents(currentUrl));
};

const evaluateByValue = async (reply: Json, failed: Json): Promise<void> => {
  if (
    !CAPTURE_ERROR_SCENARIOS.has(scenario) ||
    navigatedDuringCapture ||
    currentUrl === "about:blank"
  ) {
    await write([reply]);

    return;
  }

  navigatedDuringCapture = true;
  const replacement = [...navigationEvents(currentUrl, "L2"), ...commitEvents(currentUrl, "L2")];

  if (scenario === "navigate-during-capture") {
    await write([failed, ...replacement]);

    return;
  }

  await write([failed]);
  await delay(AFTER_CAPTURE_ERROR_MS);

  if (scenario === "exit-after-capture-error") {
    process.exit(1);
  }

  await write(replacement);
};

const closeBrowser = async (closed: Json): Promise<void> => {
  if (scenario === "ignore-close") {
    return;
  }

  await write([closed]);
  process.exit(0);
};

const answer = async ({ id, method, params, sessionId }: Command): Promise<void> => {
  const reply = (result: Json): Json => onSession(sessionId, { id, result });

  switch (method) {
    case "Browser.getVersion": {
      await write([reply({ product: PRODUCT, protocolVersion: "1.3", userAgent: "Mozilla/5.0" })]);
      break;
    }

    case "Target.setAutoAttach": {
      const attached = await autoAttach(sessionId);

      await write([reply({}), ...attached]);
      break;
    }

    case "Target.attachToBrowserTarget": {
      await write([reply({ sessionId: BROWSER_SESSION })]);
      break;
    }

    case "Target.attachToTarget": {
      await write([attachPage("S2", BROWSER_SESSION), reply({ sessionId: "S2" })]);
      break;
    }

    case "Page.setLifecycleEventsEnabled": {
      await write([reply({}), ...lifecycleReplay(sessionId)]);
      break;
    }

    case "Page.getFrameTree": {
      await write([reply({ frameTree: { frame: frame("L0", "about:blank") } })]);
      break;
    }

    case "DOM.getFrameOwner": {
      await write([onSession(sessionId, { error: FRAME_NOT_IN_TARGET, id })]);
      break;
    }

    case "Runtime.callFunctionOn": {
      await write([reply(CAPTURED_PAGE)]);
      break;
    }

    case "Runtime.evaluate": {
      await (readsByValue(params)
        ? evaluateByValue(
            reply(scenario === "evaluate-throws" ? THROWN : CAPTURED_PAGE),
            onSession(sessionId, { error: TARGET_NAVIGATED, id }),
          )
        : write([reply(UTILITY_SCRIPT)]));
      break;
    }

    case "Page.enable": {
      await enablePage(reply({}));
      break;
    }

    case "Page.navigate": {
      await answerNavigate(
        hasUrl(params) ? params.url : undefined,
        reply({ frameId: TARGET_ID, loaderId: "L1" }),
      );
      break;
    }

    case "Browser.close": {
      await closeBrowser(reply({}));
      break;
    }

    default: {
      await write([reply(fixedResults.get(method) ?? {})]);
    }
  }
};

if (scenario === "no-start") {
  process.stderr.write("fatal: fake chrome cannot start\n");
  process.exit(1);
}

let buffered = "";

input.on("data", (chunk) => {
  buffered += String(chunk);
  let end = buffered.indexOf("\0");

  while (end !== -1) {
    const parsed: unknown = JSON.parse(buffered.slice(0, end));

    buffered = buffered.slice(end + 1);
    end = buffered.indexOf("\0");

    if (isCommand(parsed)) {
      void answer(parsed);
    }
  }
});

input.on("end", () => {
  if (scenario !== "ignore-close") {
    process.exit(0);
  }
});
