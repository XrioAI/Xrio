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
  findBrowserPid,
  prepareProfile,
  PROCESS_SCAN_BUDGET_MS,
  removeScratchDir,
  scratchRoot,
  sweepAbandonedScratch,
} from "./browser-process.ts";
import { killProcessGroup, retireProcessGroup } from "./group-lifetime.ts";
import { planLaunch } from "./launch-plan.ts";
import type { LaunchPlan } from "./launch-plan.ts";
import { settleWithin, withinSignal } from "./lifetime.ts";
import { CLEANUP_BUDGET_MS, CLOSE_BUDGET_MS, DriverError, TEARDOWN_BUDGET_MS } from "./port.ts";
import type { BrowserDriver, ChromeProduct, DriverBrowser } from "./port.ts";
import { renderDocument } from "./render.ts";

const BYTES_PER_BROWSER = 512 * 1024 * 1024;

const STDERR_TAIL_CHARS = 8192;

const MIN_CHROME_MAJOR = 150;

type BrowserRequest = DocumentRequest & { mode: "headless" | "headed"; browserPath: string };

interface Launch {
  readonly cleanups: Promise<void>[];
  owned: { readonly pid: number } | undefined;
  browser: DriverBrowser | undefined;
}

interface TeardownSteps {
  readonly findBrowserPid: typeof findBrowserPid;
  readonly retireProcessGroup: typeof retireProcessGroup;
  readonly removeScratchDir: typeof removeScratchDir;
}

const defaultSteps: TeardownSteps = { findBrowserPid, removeScratchDir, retireProcessGroup };

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

const launchOwned = async (
  driver: BrowserDriver,
  plan: LaunchPlan,
  deadline: Deadline,
  launch: Launch,
): Promise<DriverBrowser> => {
  const browser = await driver.launch(
    plan,
    deadline,
    (pid) => {
      launch.owned = { pid };
      publishInternalEvent({ detail: String(pid), event: "browser-launched" });
    },
    (cleanup) => {
      launch.cleanups.push(cleanup);
    },
  );

  launch.browser = browser;

  if (launch.owned === undefined) {
    throw new DriverError({
      kind: "launch-failed",
      problem: "The driver resolved without reporting process ownership.",
    });
  }

  return browser;
};

const startBrowser = async (
  driver: BrowserDriver,
  plan: LaunchPlan,
  deadline: Deadline,
  launch: Launch,
): Promise<DriverBrowser> => {
  await writeProfile(plan);

  try {
    return await timeStage("launch", async () => await launchOwned(driver, plan, deadline, launch));
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

const browserGroup = async (
  plan: LaunchPlan,
  launch: Launch,
  steps: TeardownSteps,
  signal: AbortSignal,
): Promise<{ group: number | undefined; complete: boolean }> => {
  const owned = launch.owned?.pid;

  if (owned !== undefined) {
    return { complete: true, group: owned };
  }

  const scanSignal = AbortSignal.any([signal, AbortSignal.timeout(PROCESS_SCAN_BUDGET_MS)]);

  const [scan] = await Promise.allSettled([
    withinSignal(
      async () =>
        await steps.findBrowserPid(plan.directories.profile, PROCESS_SCAN_BUDGET_MS, scanSignal),
      scanSignal,
    ),
  ]);

  signal.throwIfAborted();

  return scan.status === "fulfilled"
    ? { complete: !scanSignal.aborted, group: scan.value }
    : { complete: false, group: undefined };
};

const stopBrowser = async (
  plan: LaunchPlan,
  launch: Launch,
  steps: TeardownSteps,
  signal: AbortSignal,
): Promise<boolean> => {
  await withinSignal(async () => {
    await settleWithin(Promise.allSettled(launch.cleanups), CLEANUP_BUDGET_MS);
  }, signal);

  const { browser } = launch;

  if (browser !== undefined) {
    await withinSignal(async () => {
      await settleWithin(browser.close(CLOSE_BUDGET_MS), CLOSE_BUDGET_MS);
    }, signal);
  }

  const { group, complete } = await browserGroup(plan, launch, steps, signal);

  if (group === undefined) {
    return complete;
  }

  return await withinSignal(async () => await steps.retireProcessGroup(group, signal), signal);
};

const tearDown = async (
  scratch: ScratchDir,
  plan: LaunchPlan,
  launch: Launch,
  steps: TeardownSteps,
): Promise<void> => {
  const signal = AbortSignal.timeout(TEARDOWN_BUDGET_MS);
  let exited = false;

  try {
    exited = await timeStage(
      "teardown",
      async () =>
        await withinSignal(async () => await stopBrowser(plan, launch, steps, signal), signal),
    );

    if (exited) {
      await withinSignal(async () => {
        await steps.removeScratchDir(scratch, signal);
      }, signal);

      return;
    }

    publishInternalEvent({
      detail: `Chrome outlived its teardown; ${scratch.path} is left for the sweep.`,
      event: "teardown-incomplete",
    });
  } catch (error) {
    const owned = launch.owned?.pid;

    if (!exited && owned !== undefined) {
      killProcessGroup(owned);
    }

    publishInternalEvent({
      detail: `Teardown of ${scratch.path} failed: ${messageOf(error)}`,
      event: "teardown-incomplete",
    });
  }
};

const renderInScratch = async (
  driver: BrowserDriver,
  request: BrowserRequest,
  scratch: ScratchDir,
  result: PromiseWithResolvers<SourceDocument>,
  steps: TeardownSteps,
): Promise<void> => {
  const plan = planFor(request, scratch);
  const launch: Launch = { browser: undefined, cleanups: [], owned: undefined };

  try {
    const browser = await startBrowser(driver, plan, request.deadline, launch);
    assertSupported(browser.product);
    result.resolve(await renderDocument(browser, request.url, request.deadline));
  } catch (error) {
    result.reject(error);
  } finally {
    await tearDown(scratch, plan, launch, steps);
  }
};

const runInBrowser = async (
  driver: BrowserDriver,
  request: BrowserRequest,
  result: PromiseWithResolvers<SourceDocument>,
  steps: TeardownSteps,
): Promise<void> => {
  try {
    await renderInScratch(
      driver,
      request,
      await createOwnedScratch(request.deadline),
      result,
      steps,
    );
  } catch (error) {
    result.reject(error);
  }
};

export const createBrowsers = (
  driver: BrowserDriver,
  maxBrowsers = defaultMaxBrowsers(),
  overrides: Partial<TeardownSteps> = {},
): Browsers => {
  const steps = { ...defaultSteps, ...overrides };
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
