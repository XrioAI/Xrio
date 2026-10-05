import { availableParallelism, totalmem } from "node:os";
import { constrainedMemory } from "node:process";

import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { clientClosed, XrioError } from "../../errors.ts";
import type { DocumentRequest, SourceDocument } from "../../types.ts";
import type { ScratchDir } from "./browser-process.ts";
import {
  createScratchDir,
  prepareProfile,
  scratchRoot,
  sweepAbandonedScratch,
} from "./browser-process.ts";
import { ChromeScope } from "./chrome-scope.ts";
import type { RetireSteps } from "./chrome-scope.ts";
import { planLaunch } from "./launch-plan.ts";
import type { LaunchPlan } from "./launch-plan.ts";
import { DriverError } from "./port.ts";
import type { BrowserDriver, ChromeProduct, DriverBrowser } from "./port.ts";
import { renderDocument } from "./render.ts";

const BYTES_PER_BROWSER = 512 * 1024 * 1024;

const STDERR_TAIL_CHARS = 8192;

const MIN_CHROME_MAJOR = 150;

type BrowserRequest = DocumentRequest & { mode: "headless" | "headed"; browserPath: string };

export interface Browsers {
  readonly load: (request: BrowserRequest) => Promise<SourceDocument>;
  readonly close: () => Promise<void>;
}

const availableMemory = (): number => {
  const limit = constrainedMemory();

  return limit > 0 ? Math.min(limit, totalmem()) : totalmem();
};

const defaultMaxBrowsers = (): number =>
  Math.max(1, Math.min(availableParallelism(), Math.floor(availableMemory() / BYTES_PER_BROWSER)));

let swept: Promise<void> | undefined;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const sweepReportingFailure = async (): Promise<void> => {
  try {
    await sweepAbandonedScratch(scratchRoot(), Date.now());
  } catch (error) {
    publishInternalEvent({
      detail: `The startup sweep failed: ${messageOf(error)}`,
      event: "sweep-incomplete",
    });
  }
};

const sweepOnce = async (): Promise<void> => {
  swept ??= sweepReportingFailure();
  await swept;
};

const launchFailed = (message: string, stderr: string, cause?: unknown): XrioError =>
  new XrioError("BROWSER_LAUNCH_FAILED", message, { cause, details: { stderr } });

const assertSupported = ({ major, version }: ChromeProduct): void => {
  if (major < MIN_CHROME_MAJOR) {
    throw launchFailed(`Chrome ${version} is older than ${MIN_CHROME_MAJOR}.`, "");
  }
};

const createOwnedScratch = async (deadline: Deadline): Promise<ScratchDir> => {
  await untilDeadline(sweepOnce, deadline);

  try {
    return await createScratchDir(Date.now());
  } catch (error) {
    throw launchFailed("Xrio could not create a scratch directory for Chrome.", "", error);
  }
};

const planFor = (request: BrowserRequest, scratch: ScratchDir): LaunchPlan =>
  planLaunch({
    browserPath: request.browserPath,
    display: process.env.DISPLAY,
    headless: request.mode === "headless",
    platform: process.platform,
    scratchDir: scratch.path,
    timezone: process.env.TZ,
    xauthority: process.env.XAUTHORITY,
  });

const writeProfile = async (plan: LaunchPlan): Promise<void> => {
  try {
    await prepareProfile(plan);
  } catch (error) {
    throw launchFailed("Xrio could not write Chrome's profile.", "", error);
  }
};

const startBrowser = async (
  driver: BrowserDriver,
  scope: ChromeScope,
  plan: LaunchPlan,
  deadline: Deadline,
): Promise<DriverBrowser> => {
  await writeProfile(plan);

  try {
    return await timeStage("launch", async () => await scope.launch(driver, plan, deadline));
  } catch (error) {
    deadline.throwIfExpired();

    if (error instanceof XrioError) {
      throw error;
    }

    if (error instanceof DriverError && error.reason.kind === "launch-failed") {
      throw launchFailed(error.message, "", error);
    }

    throw launchFailed("Chrome did not start.", messageOf(error).slice(-STDERR_TAIL_CHARS), error);
  }
};

const renderInScope = async (
  driver: BrowserDriver,
  request: BrowserRequest,
  scope: ChromeScope,
  result: PromiseWithResolvers<SourceDocument>,
): Promise<void> => {
  try {
    const plan = planFor(request, scope.scratch);
    const browser = await startBrowser(driver, scope, plan, request.deadline);
    assertSupported(browser.product);
    result.resolve(await renderDocument(browser, request.url, request.deadline));
  } catch (error) {
    result.reject(error);
  } finally {
    await scope.retire();
  }
};

const runInBrowser = async (
  driver: BrowserDriver,
  request: BrowserRequest,
  result: PromiseWithResolvers<SourceDocument>,
  steps: Partial<RetireSteps>,
): Promise<void> => {
  try {
    const scope = new ChromeScope(await createOwnedScratch(request.deadline), steps);

    await renderInScope(driver, request, scope, result);
  } catch (error) {
    result.reject(error);
  }
};

export const createBrowsers = (
  driver: BrowserDriver,
  maxBrowsers = defaultMaxBrowsers(),
  steps: Partial<RetireSteps> = {},
): Browsers => {
  const queue = new Set<() => void>();
  const accepted = new Set<Promise<SourceDocument>>();
  const idleWaiters = new Set<() => void>();
  let active = 0;
  let closed = false;

  const acquire = async (deadline: Deadline): Promise<void> => {
    deadline.throwIfExpired();

    if (active < maxBrowsers && queue.size === 0) {
      active += 1;

      return;
    }

    const { promise, resolve, reject } = Promise.withResolvers<"started">();

    const start = () => {
      resolve("started");
    };

    const abort = () => {
      queue.delete(start);
      reject(deadline.signal.reason);
    };

    queue.add(start);
    deadline.signal.addEventListener("abort", abort, { once: true });

    try {
      await promise;
    } finally {
      deadline.signal.removeEventListener("abort", abort);
    }
  };

  const release = () => {
    const [next] = queue;

    if (next !== undefined) {
      queue.delete(next);
      next();

      return;
    }

    active -= 1;

    if (active === 0) {
      for (const wake of idleWaiters) {
        wake();
      }

      idleWaiters.clear();
    }
  };

  const occupySlot = async (
    request: BrowserRequest,
    result: PromiseWithResolvers<SourceDocument>,
  ): Promise<void> => {
    try {
      await runInBrowser(driver, request, result, steps);
    } finally {
      release();
    }
  };

  const runWhenAdmitted = async (request: BrowserRequest): Promise<SourceDocument> => {
    await timeStage("queue", async () => {
      await acquire(request.deadline);
    });

    const result = Promise.withResolvers<SourceDocument>();

    void occupySlot(request, result);

    return await result.promise;
  };

  const browsersExited = async (): Promise<void> => {
    if (active === 0) {
      return;
    }

    const { promise, resolve } = Promise.withResolvers<"idle">();

    idleWaiters.add(() => {
      resolve("idle");
    });
    await promise;
  };

  const load = async (request: BrowserRequest): Promise<SourceDocument> => {
    if (closed) {
      throw clientClosed();
    }

    const work = runWhenAdmitted(request);

    accepted.add(work);

    try {
      return await work;
    } finally {
      accepted.delete(work);
    }
  };

  const close = async () => {
    closed = true;
    await Promise.allSettled(accepted);
    await browsersExited();
    await swept;
  };

  return { close, load };
};
