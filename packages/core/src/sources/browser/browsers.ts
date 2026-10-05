import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { createAdmission } from "../../admission.ts";
import { defaultCacheDir } from "../../cache-dir.ts";
import { untilDeadline } from "../../deadline.ts";
import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { clientClosed, XrioError } from "../../errors.ts";
import type { AfterCapture, HostCapabilities, Observation } from "../../humanizer/contracts.ts";
import { SEED_BYTES, seedOf } from "../../humanizer/draws.ts";
import { readHostZone } from "../../humanizer/host-zone.ts";
import { planIdentity } from "../../humanizer/humanizer.ts";
import type { IdentityPlan } from "../../humanizer/humanizer.ts";
import { presentedLocale } from "../../humanizer/surfaces.ts";
import type { IdentityContext } from "../../humanizer/surfaces.ts";
import {
  describeMismatch,
  evaluate,
  readAfterCapture,
  readObservation,
} from "../../humanizer/verify.ts";
import type { FontEvidenceOutcome } from "../../humanizer/verify.ts";
import { refuseRecordOverrides } from "../../options.ts";
import { exitFactsFor, routeFor } from "../../proxy/route.ts";
import { anonymousSessions } from "../../sessions/session.ts";
import type { SessionHold, SessionManager } from "../../sessions/session.ts";
import type { DocumentRequest, SourceDocument } from "../../types.ts";
import type { ScratchDir } from "./browser-process.ts";
import {
  createScratchDir,
  prepareProfile,
  scratchRoot,
  sweepAbandonedScratch,
} from "./browser-process.ts";
import { ChromeScope } from "./chrome-scope.ts";
import type { Closed, RetireSteps } from "./chrome-scope.ts";
import { createFontEvidenceStore } from "./font-evidence.ts";
import type { FontClaim, FontEvidenceStore } from "./font-evidence.ts";
import { hostFactsFor } from "./host-facts.ts";
import type { HostFacts } from "./host-facts.ts";
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

type BrowserRequest = DocumentRequest & { mode: "headless" | "headed"; browserPath: string };

type VisitTarget = Omit<BrowserRequest, "deadline"> & { device: IdentityContext["device"] };

interface BrowserVisit {
  readonly document: Promise<SourceDocument>;
  readonly closed: Promise<Closed>;
}

interface VisitSteps extends Partial<RetireSteps> {
  readonly random: (size: number) => Uint8Array;
  readonly sessions: SessionManager;
  readonly hostCapabilities: HostFacts["snapshotFor"];
  readonly fontEvidence: FontEvidenceStore;
  readonly planIdentity: typeof planIdentity;
  readonly evaluate: typeof evaluate;
}

interface VisitPlan {
  readonly capabilities: HostCapabilities;
  readonly fonts: FontClaim;
  readonly identity: IdentityPlan;
  readonly launch: LaunchPlan;
}

const defaultSteps: Omit<VisitSteps, "fontEvidence" | "hostCapabilities"> = {
  evaluate,
  planIdentity,
  random: randomBytes,
  sessions: anonymousSessions(),
};

export interface Browsers {
  readonly start: (request: BrowserRequest) => BrowserVisit;
  readonly load: (request: BrowserRequest) => Promise<SourceDocument>;
  readonly close: () => Promise<void>;
}

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

const deviceOf = (
  hold: SessionHold,
  scrape: Pick<IdentityContext, "mode" | "pins">,
): IdentityContext["device"] => {
  if (hold.device.kind === "record") {
    refuseRecordOverrides(hold.device.record, scrape);
  }

  return hold.device;
};

const planVisit = async (
  request: VisitTarget,
  scratch: ScratchDir,
  steps: VisitSteps,
  deadline: Deadline,
): Promise<VisitPlan> => {
  const capabilities = await steps.hostCapabilities(request.browserPath, deadline);
  const { tag: locale } = presentedLocale(request.pins);
  const fonts = await steps.fontEvidence.claim(request.browserPath, capabilities, locale, deadline);

  try {
    const hostZone = readHostZone();
    const display = process.env.DISPLAY;
    const xauthority = process.env.XAUTHORITY;
    const route = routeFor(request.proxy);

    const identity = steps.planIdentity({
      capabilities:
        fonts.evidence === undefined
          ? capabilities
          : { ...capabilities, fontEvidence: fonts.evidence },
      device: request.device,
      exit: { facts: exitFactsFor(route), route: route.kind },
      hostZone,
      mode: request.mode,
      pins: request.pins,
    });

    return {
      capabilities,
      fonts,
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
  } catch (error) {
    await fonts.settle(null);

    throw error;
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
): Promise<{ readonly observation: Observation; readonly fontEvidence: FontEvidenceOutcome }> => {
  const observation = await observeLaunch(browser, identity.read.beforeNavigation, deadline);
  const { fontEvidence, mismatches } = steps.evaluate(identity, observation);

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

const renderInScope = async (
  driver: BrowserDriver,
  steps: VisitSteps,
  request: VisitTarget,
  deadline: Deadline,
  scope: ChromeScope,
  document: PromiseWithResolvers<SourceDocument>,
): Promise<Closed> => {
  let fonts: FontClaim | undefined;

  try {
    const planned = await timeStage(
      "identity",
      async () => await planVisit(request, scope.scratch, steps, deadline),
    );

    const { capabilities, identity, launch } = planned;

    ({ fonts } = planned);

    publishInternalEvent({ detail: JSON.stringify(identity.chosen), event: "identity-chosen" });

    const browser = await startBrowser(driver, scope, launch, deadline);
    assertSupported(browser.product);
    assertProbedVersion(browser.product, capabilities);

    const { fontEvidence, observation } = await timeStage(
      "verify",
      async () => await verifyLaunch(browser, identity, deadline, steps),
    );

    await planned.fonts.settle(fontEvidence);

    const { afterCapture, source } = await renderDocument(
      browser,
      request.url,
      deadline,
      async () => await observeAfterCapture(browser, identity.read.afterCapture, deadline),
    );

    document.resolve({
      ...source,
      identity: steps.evaluate(identity, { ...observation, afterCapture }).report,
    });
  } catch (error) {
    document.reject(error);
  } finally {
    await fonts?.settle(null);
  }

  return await scope.retire();
};

export const createBrowsers = (
  driver: BrowserDriver,
  maxBrowsers?: number,
  overrides: Partial<VisitSteps> = {},
): Browsers => {
  const stopProbes = new AbortController();

  const steps: VisitSteps = {
    ...defaultSteps,
    fontEvidence: createFontEvidenceStore({ signal: stopProbes.signal }),
    hostCapabilities: hostFactsFor(defaultCacheDir()).snapshotFor,
    ...overrides,
  };

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

    await using hold = await steps.sessions.hold(
      { kind: "anonymous" },
      {
        identity: request.pins,
        seed: () => seedOf(steps.random(SEED_BYTES)),
        source: request,
      },
      request.deadline,
    );

    const deadline = hold.bind(request.deadline);

    await using _slot = await timeStage(
      "queue",
      async () => await admission.slotFor(request, deadline),
    );

    const target = { ...request, device: deviceOf(hold, request) };
    const scope = new ChromeScope(await createOwnedScratch(deadline), steps);

    return await renderInScope(driver, steps, target, deadline, scope, document);
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
