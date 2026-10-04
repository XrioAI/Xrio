import { availableParallelism, totalmem } from "node:os";
import { constrainedMemory } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { clientClosed, XrioError } from "../../errors.ts";
import type { Observation } from "../../humanizer/contracts.ts";
import { readHostZone } from "../../humanizer/host-zone.ts";
import { planIdentity } from "../../humanizer/humanizer.ts";
import type { IdentityPlan } from "../../humanizer/humanizer.ts";
import { describeMismatch, evaluate, readObservation } from "../../humanizer/verify.ts";
import { sessionFor } from "../../sessions/session.ts";
import type { DocumentRequest, SourceDocument } from "../../types.ts";
import type { ScratchDir } from "./browser-process.ts";
import {
  createScratchDir,
  prepareProfile,
  scratchRoot,
  sweepAbandonedScratch,
} from "./browser-process.ts";
import { hostCapabilities } from "./capabilities.ts";
import { ChromeScope } from "./chrome-scope.ts";
import type { Closed, RetireSteps } from "./chrome-scope.ts";
import { planLaunch } from "./launch-plan.ts";
import type { LaunchPlan } from "./launch-plan.ts";
import { DriverError } from "./port.ts";
import type { BrowserDriver, ChromeProduct, DriverBrowser } from "./port.ts";
import { renderDocument } from "./render.ts";

const BYTES_PER_BROWSER = 512 * 1024 * 1024;

const STDERR_TAIL_CHARS = 8192;

const MIN_CHROME_MAJOR = 150;

const VERIFY_TIMEOUT_MS = 10_000;

const UNSIZED_RETRY_MS = 250;

type BrowserRequest = DocumentRequest & { mode: "headless" | "headed"; browserPath: string };

type VisitTarget = Omit<BrowserRequest, "deadline">;

interface BrowserVisit {
  readonly document: Promise<SourceDocument>;
  readonly closed: Promise<Closed>;
}

interface VisitSteps extends Partial<RetireSteps> {
  readonly sessionFor: typeof sessionFor;
  readonly hostCapabilities: typeof hostCapabilities;
  readonly planIdentity: typeof planIdentity;
  readonly evaluate: typeof evaluate;
}

interface VisitPlan {
  readonly identity: IdentityPlan;
  readonly launch: LaunchPlan;
}

const defaultSteps: VisitSteps = { evaluate, hostCapabilities, planIdentity, sessionFor };

export interface Browsers {
  readonly start: (request: BrowserRequest) => BrowserVisit;
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
  new XrioError("BROWSER_LAUNCH_FAILED", message, { cause, details: { mismatches: [], stderr } });

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

const planVisit = (request: VisitTarget, scratch: ScratchDir, steps: VisitSteps): VisitPlan => {
  const hostZone = readHostZone();
  const display = process.env.DISPLAY;
  const xauthority = process.env.XAUTHORITY;

  const identity = steps.planIdentity({
    capabilities: steps.hostCapabilities(),
    hostZone,
    mode: request.mode,
  });

  return {
    identity,
    launch: planLaunch({
      browserArgs: request.browserArgs,
      browserPath: request.browserPath,
      display,
      headless: request.mode === "headless",
      identity: identity.inputs,
      scratchDir: scratch.path,
      xauthority,
    }),
  };
};

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

const isText = (value: unknown): value is string => typeof value === "string";

const observeLaunch = async (
  browser: DriverBrowser,
  read: string,
  deadline: Deadline,
): Promise<Observation> => {
  try {
    using stage = deadline.startStage(VERIFY_TIMEOUT_MS);
    const reading = deadline.boundTo(stage.signal);

    const readOnce = async (): Promise<Observation> =>
      readObservation(browser.product, await browser.evaluateIsolated(read, isText, reading));

    const first = await readOnce();

    if (first.outerWidth > 0) {
      return first;
    }

    await delay(UNSIZED_RETRY_MS, undefined, { signal: reading.signal });

    return await readOnce();
  } catch (error) {
    deadline.throwIfExpired();
    throw launchFailed(
      `Xrio could not read Chrome's launch identity: ${messageOf(error)}`,
      "",
      error,
    );
  }
};

const verifyLaunch = async (
  browser: DriverBrowser,
  identity: IdentityPlan,
  deadline: Deadline,
  steps: VisitSteps,
): Promise<void> => {
  const observation = await observeLaunch(browser, identity.read, deadline);
  const { mismatches } = steps.evaluate(identity.expected, observation);

  if (mismatches.length > 0) {
    const fields = mismatches.map((mismatch) => describeMismatch(mismatch, observation)).join(", ");

    throw new XrioError(
      "BROWSER_LAUNCH_FAILED",
      `Chrome's launch identity does not match Xrio's plan: ${fields}.`,
      { details: { mismatches, stderr: "" } },
    );
  }
};

const renderInScope = async (
  driver: BrowserDriver,
  steps: VisitSteps,
  request: VisitTarget,
  deadline: Deadline,
  scope: ChromeScope,
  document: PromiseWithResolvers<SourceDocument>,
): Promise<Closed> => {
  try {
    const { identity, launch } = planVisit(request, scope.scratch, steps);
    const browser = await startBrowser(driver, scope, launch, deadline);
    assertSupported(browser.product);
    await timeStage("verify", async () => {
      await verifyLaunch(browser, identity, deadline, steps);
    });
    document.resolve(await renderDocument(browser, request.url, deadline));
  } catch (error) {
    document.reject(error);
  }

  return await scope.retire();
};

const createAdmission = (maxBrowsers: number) => {
  const queue = new Set<() => void>();
  let active = 0;

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
  };

  return { acquire, release };
};

export const createBrowsers = (
  driver: BrowserDriver,
  maxBrowsers = defaultMaxBrowsers(),
  overrides: Partial<VisitSteps> = {},
): Browsers => {
  const steps = { ...defaultSteps, ...overrides };
  const admission = createAdmission(maxBrowsers);
  const visits = new Set<Promise<Closed>>();
  let closed = false;

  const visitWhenAdmitted = async (
    request: BrowserRequest,
    document: PromiseWithResolvers<SourceDocument>,
  ): Promise<Closed> => {
    if (closed) {
      throw clientClosed();
    }

    await timeStage("queue", async () => {
      await admission.acquire(request.deadline);
    });

    try {
      const deadline = request.deadline.boundTo(steps.sessionFor().ownership.signal);
      const scope = new ChromeScope(await createOwnedScratch(deadline), steps);

      return await renderInScope(driver, steps, request, deadline, scope, document);
    } finally {
      admission.release();
    }
  };

  const visit = async (
    request: BrowserRequest,
    document: PromiseWithResolvers<SourceDocument>,
  ): Promise<Closed> => {
    try {
      return await visitWhenAdmitted(request, document);
    } catch (error) {
      document.reject(error);

      return { exited: true };
    }
  };

  const trackUntilClosed = async (closing: Promise<Closed>): Promise<void> => {
    visits.add(closing);
    await closing;
    visits.delete(closing);
  };

  const start = (request: BrowserRequest): BrowserVisit => {
    const document = Promise.withResolvers<SourceDocument>();
    const closing = visit(request, document);

    void trackUntilClosed(closing);
    void Promise.allSettled([document.promise]);

    return { closed: closing, document: document.promise };
  };

  const load = async (request: BrowserRequest): Promise<SourceDocument> =>
    await start(request).document;

  const close = async () => {
    closed = true;
    await Promise.allSettled(visits);
    await swept;
  };

  return { close, load, start };
};
