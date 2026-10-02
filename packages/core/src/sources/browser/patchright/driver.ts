import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import type { BrowserContext, CDPSession, Page, Request } from "patchright-core";

import { untilDeadline } from "../../../deadline.ts";
import type { Deadline } from "../../../deadline.ts";
import { findBrowserPid, killProcessGroup } from "../browser-process.ts";
import type { LaunchPlan } from "../launch-plan.ts";
import { CLOSE_BUDGET_MS, DriverError } from "../port.ts";
import type {
  BrowserDriver,
  CleanupSink,
  DriverBrowser,
  DriverEvent,
  DriverListener,
  RawHeaders,
  ResultGuard,
} from "../port.ts";

const LAUNCH_TIMEOUT_MS = 30_000;

const NET_ERROR = /net::ERR_[A-Z0-9_]+/u;

const DOWNLOAD_STARTED = /Download is starting/u;

const ABORTED_FOR_DOWNLOAD = "net::ERR_ABORTED";

const DOCUMENT_REPLACED = /Execution context was destroyed/u;

const BROWSER_GONE =
  /Target page, context or browser has been closed|Target crashed|Page crashed|Browser has been closed/u;

const PATCHRIGHT_DISABLED_FEATURES =
  "--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,BoundaryEventDispatchTracksNodeRemoval," +
  "DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay," +
  "MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument," +
  "OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion";

const REPLACED_PATCHRIGHT_SWITCHES = [PATCHRIGHT_DISABLED_FEATURES, "--hide-scrollbars"];

const REQUIRED_PATCHES = [
  {
    applied: (source: string) => !source.includes("userGesture: true"),
    missing: "still marks evaluates as user gestures",
  },
  {
    applied: (source: string) => source.includes('let response2 = "CancelAuth";'),
    missing: "still defers HTTP auth challenges to Chrome",
  },
];

let patched: Promise<void> | undefined;

const settle = async (operation: Promise<unknown>): Promise<void> => {
  await Promise.allSettled([operation]);
};

const settleWithin = async (operation: Promise<unknown>, budgetMs: number): Promise<void> => {
  const budget = new AbortController();

  try {
    await Promise.race([
      settle(operation),
      settle(delay(budgetMs, undefined, { signal: budget.signal })),
    ]);
  } finally {
    budget.abort();
  }
};

const browserGone = (cause: unknown): DriverError | undefined =>
  cause instanceof Error && BROWSER_GONE.test(cause.message)
    ? new DriverError({ kind: "browser-gone" }, { cause })
    : undefined;

const assertPatched = async (): Promise<void> => {
  const bundle = fileURLToPath(
    new URL("lib/coreBundle.js", import.meta.resolve("patchright-core/package.json")),
  );

  const source = await readFile(bundle, "utf-8");
  const missing = REQUIRED_PATCHES.filter(({ applied }) => !applied(source));

  if (missing.length > 0) {
    throw new DriverError({
      kind: "launch-failed",
      problem: `patchright-core ${missing.map((patch) => patch.missing).join(" and ")}; reinstall to apply its patch.`,
    });
  }
};

const ensurePatched = async (): Promise<void> => {
  patched ??= assertPatched();

  try {
    await patched;
  } catch (error) {
    patched = undefined;
    throw error;
  }
};

const headerPairs = (headers: Record<string, string>): RawHeaders =>
  Object.entries(headers).map(([name, value]) => [name, value] as const);

const eventStream = () => {
  const listeners = new Set<DriverListener>();

  const emit = (event: DriverEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const onEvent = (listener: DriverListener) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  return { emit, onEvent };
};

const watchMainFrame = async (
  session: CDPSession,
  emit: (event: DriverEvent) => void,
): Promise<void> => {
  const documentRequests = new Set<string>();
  const { frameTree } = await session.send("Page.getFrameTree");
  const mainFrameId = frameTree.frame.id;

  session.on("Page.frameNavigated", ({ frame }) => {
    if (frame.id === mainFrameId) {
      emit({ frameId: frame.id, loaderId: frame.loaderId, type: "commit" });
    }
  });
  session.on("Page.lifecycleEvent", ({ frameId, loaderId, name }) => {
    if (frameId === mainFrameId && name === "DOMContentLoaded") {
      emit({ frameId, loaderId, type: "dom-content-loaded" });
    }
  });
  session.on(
    "Network.requestWillBeSent",
    ({ frameId, loaderId, redirectResponse, requestId, type }) => {
      if (type !== "Document" || frameId !== mainFrameId) {
        return;
      }

      documentRequests.add(requestId);

      if (redirectResponse !== undefined) {
        emit({
          hop: {
            headers: headerPairs(redirectResponse.headers),
            isRedirect: true,
            loaderId,
            requestId,
            status: redirectResponse.status,
            url: redirectResponse.url,
          },
          type: "document-response",
        });
      }
    },
  );
  session.on("Network.responseReceived", ({ frameId, loaderId, requestId, response, type }) => {
    if (type === "Document" && frameId === mainFrameId) {
      emit({
        hop: {
          headers: headerPairs(response.headers),
          isRedirect: false,
          loaderId,
          requestId,
          status: response.status,
          url: response.url,
        },
        type: "document-response",
      });
    }
  });
  session.on("Network.responseReceivedExtraInfo", ({ headers, requestId, statusCode }) => {
    if (documentRequests.has(requestId)) {
      emit({ headers: headerPairs(headers), requestId, status: statusCode, type: "raw-headers" });
    }
  });
  await session.send("Page.enable");
  await session.send("Page.setLifecycleEventsEnabled", { enabled: true });
  await session.send("Network.enable");
};

const fromExtensionWorker = (request: Request): boolean =>
  request.serviceWorker()?.url().startsWith("chrome-extension://") ?? false;

const watchPage = (context: BrowserContext, page: Page, emit: (event: DriverEvent) => void) => {
  page.on("crash", () => {
    emit({ type: "crash" });
  });
  page.on("dialog", (dialog) => {
    void settle(dialog.dismiss());
  });
  context.on("request", (request) => {
    if (!fromExtensionWorker(request)) {
      emit({ type: "request", url: request.url() });
    }
  });
  context.on("close", () => {
    emit({ type: "disconnect" });
  });
};

const launchContext = async (plan: LaunchPlan, deadline: Deadline): Promise<BrowserContext> => {
  const { chromium } = await import("patchright-core");

  return await chromium.launchPersistentContext(plan.directories.profile, {
    acceptDownloads: false,
    args: [...plan.switches],
    artifactsDir: plan.directories.downloads,
    chromiumSandbox: true,
    colorScheme: null,
    contrast: null,
    downloadsPath: plan.directories.downloads,
    env: plan.env,
    executablePath: plan.executable,
    forcedColors: null,
    handleSIGHUP: false,
    handleSIGINT: false,
    handleSIGTERM: false,
    headless: plan.headless,
    ignoreDefaultArgs: REPLACED_PATCHRIGHT_SWITCHES,
    reducedMotion: null,
    timeout: deadline.stageTimeout(LAUNCH_TIMEOUT_MS),
    viewport: null,
  });
};

const closeWhenLaunched = async (launching: Promise<BrowserContext>): Promise<void> => {
  const [launched] = await Promise.allSettled([launching]);

  if (launched.status === "fulfilled") {
    await settle(launched.value.close());
  }
};

const abandonLaunch = async (plan: LaunchPlan, launching: Promise<BrowserContext>) => {
  const pid = await findBrowserPid(plan.directories.profile);

  if (pid !== undefined) {
    killProcessGroup(pid);
  }

  await settleWithin(closeWhenLaunched(launching), CLOSE_BUDGET_MS);
};

const launchBefore = async (
  plan: LaunchPlan,
  deadline: Deadline,
  deferCleanup: CleanupSink,
): Promise<BrowserContext> => {
  deadline.throwIfExpired();
  const launching = launchContext(plan, deadline);

  try {
    return await untilDeadline(async () => await launching, deadline);
  } catch (error) {
    deferCleanup(abandonLaunch(plan, launching));
    throw error;
  }
};

const netErrorOf = (message: string): string | undefined =>
  DOWNLOAD_STARTED.test(message) ? ABORTED_FOR_DOWNLOAD : NET_ERROR.exec(message)?.[0];

const navigateTo = async (page: Page, url: string, deadline: Deadline): Promise<void> => {
  try {
    await untilDeadline(
      async () =>
        await page.goto(url, {
          timeout: deadline.stageTimeout(Number.POSITIVE_INFINITY),
          waitUntil: "commit",
        }),
      deadline,
    );
  } catch (error) {
    const netError = error instanceof Error ? netErrorOf(error.message) : undefined;

    throw netError === undefined
      ? (browserGone(error) ?? error)
      : new DriverError({ kind: "navigation-failed", netError }, { cause: error });
  }
};

const evaluateIn = async <Result>(
  page: Page,
  expression: string,
  isResult: ResultGuard<Result>,
  deadline: Deadline,
): Promise<Result> => {
  let value: unknown;

  try {
    value = await untilDeadline(
      async () => await page.evaluate(expression, undefined, true),
      deadline,
    );
  } catch (error) {
    if (error instanceof Error && DOCUMENT_REPLACED.test(error.message)) {
      throw new DriverError({ kind: "document-replaced" }, { cause: error });
    }

    throw browserGone(error) ?? error;
  }

  if (!isResult(value)) {
    throw new Error("The isolated evaluate returned an unexpected value.");
  }

  return value;
};

const openBrowser = async (plan: LaunchPlan, context: BrowserContext): Promise<DriverBrowser> => {
  const [page] = context.pages();
  const pid = await findBrowserPid(plan.directories.profile);

  if (page === undefined || pid === undefined) {
    throw new DriverError({
      kind: "launch-failed",
      problem: "Chrome started without its first page.",
    });
  }

  const events = eventStream();
  watchPage(context, page, events.emit);
  await watchMainFrame(await context.newCDPSession(page), events.emit);

  return {
    close: async (budgetMs) => {
      await settleWithin(context.close(), budgetMs);
    },
    evaluateIsolated: async (expression, isResult, deadline) =>
      await evaluateIn(page, expression, isResult, deadline),
    navigate: async (url, deadline) => {
      await navigateTo(page, url, deadline);
    },
    onEvent: events.onEvent,
    pid,
    product: context.browser()?.version() ?? "",
  };
};

export const patchrightDriver: BrowserDriver = {
  launch: async (plan, deadline, deferCleanup) => {
    await ensurePatched();
    const context = await launchBefore(plan, deadline, deferCleanup);

    try {
      return await untilDeadline(async () => await openBrowser(plan, context), deadline);
    } catch (error) {
      deferCleanup(settleWithin(context.close(), CLOSE_BUDGET_MS));
      throw error;
    }
  },
};
