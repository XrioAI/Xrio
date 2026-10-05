import { setTimeout as delay } from "node:timers/promises";

import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { clientClosed, isXrioError, XrioError } from "../../errors.ts";
import type { AfterCapture, HostCapabilities, Observation } from "../../humanizer/contracts.ts";
import type { IdentityPlan } from "../../humanizer/humanizer.ts";
import {
  describeMismatch,
  evaluate,
  readAfterCapture,
  readObservation,
} from "../../humanizer/verify.ts";
import type { FontEvidenceOutcome } from "../../humanizer/verify.ts";
import type { HeldDeadline } from "../../lifetime.ts";
import type { Slot } from "../../slot.ts";
import type { SourceDocument } from "../../types.ts";
import type { Visit, VisitPlan } from "../visit.ts";
import type { ScratchDir } from "./browser-process.ts";
import {
  createScratchDir,
  prepareProfile,
  scratchRoot,
  sweepAbandonedScratch,
} from "./browser-process.ts";
import { ChromeScope } from "./chrome-scope.ts";
import type { Closed, RetireSteps } from "./chrome-scope.ts";
import { planLaunch } from "./launch-plan.ts";
import type { LaunchPlan } from "./launch-plan.ts";
import { DriverError } from "./port.ts";
import type { BrowserDriver, ChromeProduct, DriverBrowser } from "./port.ts";
import { renderDocument } from "./render.ts";

const STDERR_TAIL_CHARS = 8192;

const MIN_CHROME_MAJOR = 150;

const VERIFY_TIMEOUT_MS = 10_000;

const UNSIZED_RETRY_MS = 250;

const AFTER_CAPTURE_CAP_MS = 250;

const AFTER_CAPTURE_FLOOR_MS = 50;

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

const assertProbedVersion = ({ version }: ChromeProduct, { fork }: HostCapabilities): void => {
  if (fork !== undefined && version !== fork.version) {
    throw launchFailed(
      `Chrome launched as version ${version}, but the Xrio fork package at ${fork.packageDir} reported ${fork.version} to its version probe.`,
      "",
    );
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
  slot: Slot,
  deadline: Deadline,
): Promise<DriverBrowser> => {
  await writeProfile(plan);
  slot.assertHeld();

  try {
    return await timeStage("launch", async () => await scope.launch(driver, plan, deadline));
  } catch (error) {
    if (isXrioError(error) || deadline.signal.aborted) {
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
    if (isXrioError(error) || deadline.signal.aborted) {
      throw error;
    }

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
): Promise<{ readonly observation: Observation; readonly fontEvidence: FontEvidenceOutcome }> => {
  const observation = await observeLaunch(browser, identity.read.beforeNavigation, deadline);
  const { fontEvidence, mismatches } = evaluate(identity, observation);

  if (mismatches.length > 0) {
    const fields = mismatches.map((mismatch) => describeMismatch(mismatch, observation)).join(", ");

    throw new XrioError(
      "BROWSER_LAUNCH_FAILED",
      `Chrome's launch identity does not match Xrio's plan: ${fields}.`,
      { details: { mismatches, stderr: "" } },
    );
  }

  return { fontEvidence, observation };
};

const observeAfterCapture = async (
  browser: DriverBrowser,
  read: string,
  deadline: Deadline,
): Promise<AfterCapture> => {
  const budgetMs = Math.min(AFTER_CAPTURE_CAP_MS, Math.floor(deadline.remainingMs() / 2));

  if (budgetMs < AFTER_CAPTURE_FLOOR_MS) {
    return { kind: "skipped" };
  }

  try {
    using stage = deadline.startStage(budgetMs);

    return readAfterCapture(
      await browser.evaluateIsolated(read, isText, deadline.boundTo(stage.signal)),
    );
  } catch {
    return { kind: "failed" };
  }
};

type BrowserVisitPlan = Extract<VisitPlan, { kind: "browser" }>;

export interface Browsers {
  readonly start: (plan: BrowserVisitPlan, slot: Slot, deadline: HeldDeadline) => Visit;
  readonly close: () => Promise<void>;
}

const settleFonts = async ({ fonts }: BrowserVisitPlan): Promise<void> => {
  try {
    await fonts.settle(null);
  } catch (error) {
    publishInternalEvent({ detail: messageOf(error), event: "font-settlement-failed" });
  }
};

const renderInScope = async (
  driver: BrowserDriver,
  plan: BrowserVisitPlan,
  slot: Slot,
  deadline: HeldDeadline,
  scope: ChromeScope,
  document: PromiseWithResolvers<SourceDocument>,
): Promise<Closed> => {
  const { capabilities, fonts, identity } = plan;

  try {
    publishInternalEvent({ detail: JSON.stringify(identity.chosen), event: "identity-chosen" });

    const launch = planLaunch({
      browserArgs: plan.browserArgs,
      browserPath: plan.browserPath,
      display: process.env.DISPLAY,
      headless: plan.mode === "headless",
      identity: identity.inputs,
      scratchDir: scope.scratch.path,
      xauthority: process.env.XAUTHORITY,
    });

    const browser = await startBrowser(driver, scope, launch, slot, deadline);
    assertSupported(browser.product);
    assertProbedVersion(browser.product, capabilities);

    const { fontEvidence, observation } = await timeStage(
      "verify",
      async () => await verifyLaunch(browser, identity, deadline),
    );

    await fonts.settle(fontEvidence);

    const { afterCapture, source } = await renderDocument(
      browser,
      plan.url,
      deadline,
      async () => await observeAfterCapture(browser, identity.read.afterCapture, deadline),
    );

    document.resolve({
      ...source,
      identity: evaluate(identity, { ...observation, afterCapture }).report,
    });
  } catch (error) {
    document.reject(error);
  } finally {
    await settleFonts(plan);
  }

  return await scope.retire();
};

export const createBrowsers = (
  driver: BrowserDriver,
  steps: Partial<RetireSteps> = {},
): Browsers => {
  const visits = new Set<Promise<Closed>>();
  let closed = false;

  const visit = async (
    plan: BrowserVisitPlan,
    slot: Slot,
    deadline: HeldDeadline,
    document: PromiseWithResolvers<SourceDocument>,
  ): Promise<Closed> => {
    try {
      slot.assertHeld();
      deadline.throwIfExpired();

      if (closed) {
        throw clientClosed();
      }

      const scope = new ChromeScope(await createOwnedScratch(deadline), steps);

      return await renderInScope(driver, plan, slot, deadline, scope, document);
    } catch (error) {
      document.reject(error);
      await settleFonts(plan);

      return { exited: true };
    }
  };

  const trackUntilClosed = async (closing: Promise<Closed>): Promise<void> => {
    visits.add(closing);
    await closing;
    visits.delete(closing);
  };

  const start: Browsers["start"] = (plan, slot, deadline) => {
    const document = Promise.withResolvers<SourceDocument>();
    const closing = visit(plan, slot, deadline, document);

    void trackUntilClosed(closing);
    void Promise.allSettled([document.promise]);

    return { closed: closing, document: document.promise };
  };

  const close = async () => {
    closed = true;
    await Promise.allSettled(visits);
    await swept;
  };

  return { close, start };
};
