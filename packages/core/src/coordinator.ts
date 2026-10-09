import { randomBytes, randomUUID } from "node:crypto";

import type { Admission } from "./admission.ts";
import { createAnswer } from "./answer.ts";
import type { Answer } from "./answer.ts";
import type { ResolvedConfig } from "./config.ts";
import type { Deadline } from "./deadline.ts";
import { inScrapeContext, timeStage } from "./diagnostics.ts";
import { clientClosed, isXrioError, sessionUnavailable } from "./errors.ts";
import type { XrioError } from "./errors.ts";
import { deviceDigest } from "./humanizer/contracts.ts";
import type { HostCapabilities } from "./humanizer/contracts.ts";
import { SEED_BYTES, seedOf } from "./humanizer/draws.ts";
import { readHostZone } from "./humanizer/host-zone.ts";
import { httpIdentity, planIdentity } from "./humanizer/humanizer.ts";
import { presentableRecord } from "./humanizer/read-record.ts";
import { identityForVisit, presentedLocale } from "./humanizer/surfaces.ts";
import type { ScrapeIntent } from "./intent.ts";
import type { HeldDeadline } from "./lifetime.ts";
import { parseProxy } from "./options.ts";
import { outcomeOf, scrapeError } from "./outcome.ts";
import type { ScrapeOutcome } from "./outcome.ts";
import { lookupProxyInfo } from "./proxy/info.ts";
import type { ProxyObservation } from "./proxy/info.ts";
import { ProxyManager } from "./proxy/manager.ts";
import { exitFactsFor, routeFor } from "./proxy/route.ts";
import { bindSessionExit } from "./proxy/session-exit.ts";
import { createRetries } from "./retries.ts";
import type { Retries } from "./retries.ts";
import { reportSkippedCookies } from "./seed-cookies.ts";
import type { ClaimChecks, SessionHold, SessionManager } from "./sessions/session.ts";
import type { FontEvidenceStore } from "./sources/browser/font-evidence.ts";
import type { HostFacts } from "./sources/browser/host-facts.ts";
import type { FinishedVisit, SiteVisit, Sources, VisitPlan } from "./sources/visit.ts";
import type { ProxyEndpoint, SessionSummary, SourceDocument } from "./types.ts";

interface ScrapeRun {
  readonly answer: Promise<SourceDocument>;
  readonly settled: Promise<void>;
}

export interface Scrapes {
  readonly assertOpen: () => void;
  readonly start: (intent: ScrapeIntent, deadline: Deadline) => ScrapeRun;
  readonly close: () => Promise<void>;
}

interface Dependencies {
  readonly host: HostFacts;
  readonly comparisonBinary: string | undefined;
  readonly sessions: Pick<SessionManager, "hold">;
  readonly admission: Admission;
  readonly sources: Sources;
  readonly fonts: FontEvidenceStore;
  readonly random: (size: number) => Uint8Array;
  readonly retryRandom: () => number;
  readonly closing: AbortSignal;
  readonly configuredProxy: ProxyEndpoint | undefined;
  readonly managedProxy: ProxyManager | undefined;
  readonly proxyInfo: (proxy: ProxyEndpoint, deadline: Deadline) => Promise<ProxyObservation>;
}

interface VisitContext {
  readonly answer: Answer;
  readonly intent: ScrapeIntent;
  readonly hold: SessionHold;
  readonly held: HeldDeadline;
  readonly capabilities: HostCapabilities | undefined;
  readonly dependencies: Dependencies;
}

const comparisonFacts = async ({
  dependencies,
  held,
}: VisitContext): Promise<HostCapabilities | null> => {
  try {
    return await dependencies.host.snapshotFor(dependencies.comparisonBinary, held);
  } catch {
    held.throwIfExpired();

    return null;
  }
};

const sessionExit = async ({ dependencies, held, hold, intent }: VisitContext) => {
  const exit = await bindSessionExit(
    {
      binding: hold.binding,
      drawStickyId: hold.drawStickyId,
      manager: intent.route === undefined ? dependencies.managedProxy : undefined,
      observe: dependencies.proxyInfo,
      proxy: intent.route ?? dependencies.configuredProxy,
    },
    held,
  );

  if (exit.kind === "changed") {
    await hold.retire();
    throw sessionUnavailable("exit-changed", "The session's exit left its region.");
  }

  return exit;
};

const plannedVisit = async (context: VisitContext): Promise<VisitPlan> => {
  const { dependencies, held, hold, intent } = context;
  const proxy = intent.route ?? dependencies.configuredProxy;

  if (intent.source.mode === "http") {
    return {
      capabilities: await comparisonFacts(context),
      cookies: intent.cookies.seeds,
      headers: intent.source.headers,
      identity: httpIdentity(identityForVisit(intent.identity, hold.device)),
      kind: "http",
      proxy,
      url: intent.url,
    };
  }

  const exit = await sessionExit(context);
  const route = routeFor(exit.proxy);
  const { observation } = exit;

  held.throwIfExpired();
  const pins = identityForVisit(intent.identity, hold.device, observation?.locale);

  const capabilities =
    context.capabilities ?? (await dependencies.host.snapshotFor(intent.source.browserPath, held));

  const fonts = await dependencies.fonts.claim(
    intent.source.browserPath,
    capabilities,
    presentedLocale(pins).tag,
    held,
  );

  try {
    const identity = planIdentity({
      capabilities:
        fonts.evidence === undefined
          ? capabilities
          : { ...capabilities, fontEvidence: fonts.evidence },
      device: hold.device,
      exit: { facts: exitFactsFor(route, observation), route: route.kind },
      followExit: route.kind === "proxy",
      hostZone: readHostZone(),
      mode: intent.source.mode,
      pins,
    });

    return {
      ...intent.source,
      browserArgs: hold.browserArgs ?? intent.source.browserArgs,
      capabilities,
      cookies: intent.cookies.seeds,
      exitAddress: observation?.exitIp,
      fonts,
      identity,
      kind: "browser",
      profile: hold.profile,
      proxy: exit.proxy,
      sessionBinding: exit.binding,
      url: intent.url,
    };
  } catch (error) {
    await fonts.settle(null);

    throw error;
  }
};

type Continuation =
  | { readonly kind: "complete" }
  | { readonly kind: "revisit" }
  | { readonly kind: "retry"; readonly delayMs: number };

interface VisitResult extends FinishedVisit {
  readonly next: Continuation;
  readonly outcome: ScrapeOutcome;
}

const planVisits = (context: VisitContext): (() => Promise<VisitPlan>) => {
  let frozen: VisitPlan | undefined;

  return async () => {
    if (frozen === undefined) {
      frozen = await plannedVisit(context);

      return frozen;
    }

    if (frozen.kind === "http") {
      return frozen;
    }

    const fonts = await context.dependencies.fonts.claim(
      frozen.browserPath,
      frozen.capabilities,
      frozen.identity.chosen.surfaces.locale.tag,
      context.held,
    );

    return { ...frozen, fonts };
  };
};

const continuationFor = (
  outcome: ScrapeOutcome,
  context: VisitContext,
  terminal: boolean,
  retries: Retries,
): Continuation => {
  if (outcome.kind === "failed") {
    const delayMs = retries.next(outcome.error);

    return delayMs === undefined ? { kind: "complete" } : { delayMs, kind: "retry" };
  }

  return !terminal && context.hold.revisitWanted(outcome)
    ? { kind: "revisit" }
    : { kind: "complete" };
};

const siteVisitOf = (
  outcome: ScrapeOutcome,
  site: string,
  exitAddress: string | null,
): SiteVisit | undefined => {
  if (outcome.kind !== "document" || outcome.document.identity.mode === "http") {
    return undefined;
  }

  const { block, identity } = outcome.document;

  return {
    challengeOutcome: block.challenge?.outcome ?? null,
    challengeRules: block.challenge?.rounds.map((round) => round.rule) ?? [],
    deviceDigest: deviceDigest(identity.record),
    exitAddress,
    site,
    vendor: block.vendor,
    verdict: block.verdict,
  };
};

const withSession = (outcome: ScrapeOutcome, session: SessionSummary | undefined): ScrapeOutcome =>
  outcome.kind === "document" && session !== undefined
    ? { ...outcome, document: { ...outcome.document, session } }
    : outcome;

const recordOf = (outcome: ScrapeOutcome): FinishedVisit["record"] =>
  outcome.kind === "document" && outcome.document.identity.mode !== "http"
    ? outcome.document.identity.record
    : null;

class AttemptStartError extends Error {
  override readonly name = "AttemptStartError";
  readonly failure: Error;

  constructor(failure: Error) {
    super(failure.message, { cause: failure });
    this.failure = failure;
  }
}

const startAttempt = async <Result>(
  start: () => Result | Promise<Result>,
  held: HeldDeadline,
): Promise<Result> => {
  try {
    return await start();
  } catch (error) {
    throw new AttemptStartError(scrapeError(error, held));
  }
};

const visitOnce = async (
  context: VisitContext,
  terminal: boolean,
  retries: Retries,
  planVisit: () => Promise<VisitPlan>,
): Promise<VisitResult> => {
  const { answer, dependencies, held, hold, intent } = context;

  await using slot = await startAttempt(
    async () =>
      await timeStage(
        "queue",
        async () => await dependencies.admission.slotFor(intent.source, held),
        held,
      ),
    held,
  );

  const plan = await startAttempt(async () => await timeStage("identity", planVisit, held), held);
  let transferred = false;

  try {
    const visit = await startAttempt(() => dependencies.sources.start(plan, slot, held), held);

    transferred = true;

    const outcome = await outcomeOf(visit.document, held);
    const next = continuationFor(outcome, context, terminal, retries);

    const siteVisit = siteVisitOf(
      outcome,
      intent.url.hostname,
      plan.kind === "browser" ? (plan.exitAddress ?? null) : null,
    );

    const answered = withSession(
      outcome,
      siteVisit === undefined ? undefined : hold.summary(siteVisit),
    );

    if (next.kind !== "retry") {
      answer.offer(answered, next.kind === "complete");
    }

    const record = recordOf(outcome);

    return {
      binding: record === null || plan.kind !== "browser" ? undefined : plan.sessionBinding,
      browserArgs: plan.kind === "browser" ? plan.browserArgs : [],
      closed: await visit.closed,
      next,
      outcome: answered,
      record,
      siteVisit,
    };
  } finally {
    if (!transferred && plan.kind === "browser") {
      await plan.fonts.settle(null);
    }
  }
};

// oxlint-disable no-await-in-loop -- Attempts must close and finish the same session before the next attempt starts.
const visitAfterStartFailures = async (
  context: VisitContext,
  terminal: boolean,
  retries: Retries,
  planVisit: () => Promise<VisitPlan>,
): Promise<VisitResult> => {
  for (;;) {
    try {
      return await visitOnce(context, terminal, retries, planVisit);
    } catch (error) {
      if (!(error instanceof AttemptStartError)) {
        throw error;
      }

      const { failure } = error;
      const delayMs = retries.next(failure);

      if (delayMs === undefined || !(await retries.wait(delayMs))) {
        throw failure;
      }
    }
  }
};

const completeVisits = async (context: VisitContext, retries: Retries): Promise<void> => {
  let terminal = false;
  let planVisit = planVisits(context);

  for (;;) {
    const visit = await visitAfterStartFailures(context, terminal, retries, planVisit);

    await context.hold.finish(visit);

    if (visit.next.kind === "complete") {
      break;
    }

    if (visit.next.kind === "retry") {
      if (!visit.closed.exited || !(await retries.wait(visit.next.delayMs))) {
        context.answer.offer(visit.outcome, true);
        break;
      }
    } else {
      terminal = true;
      planVisit = planVisits(context);
    }
  }
};

// oxlint-enable no-await-in-loop

const settleAnswerOnAbort = (answer: Answer, deadline: Deadline): Disposable => {
  const { signal } = deadline;

  const fail = () => {
    answer.fail(scrapeError(signal.reason, deadline));
  };

  if (signal.aborted) {
    fail();
  } else {
    signal.addEventListener("abort", fail, { once: true });
  }

  return {
    [Symbol.dispose]: () => {
      signal.removeEventListener("abort", fail);
    },
  };
};

interface BrowserScrape {
  readonly mode: "headless" | "headed";
  readonly capabilities: HostCapabilities;
  readonly browserArgs: readonly string[];
}

const sessionBrowser = async (
  intent: ScrapeIntent,
  deadline: Deadline,
  { host }: Dependencies,
): Promise<BrowserScrape | undefined> => {
  if (intent.source.mode === "http" || intent.session.kind === "anonymous") {
    return undefined;
  }

  const { browserArgs, browserPath, mode } = intent.source;
  const capabilities = await host.snapshotFor(browserPath, deadline);
  const chromeMajor = await host.chromeMajorFor(browserPath, capabilities, deadline);

  return { browserArgs, capabilities: { ...capabilities, chromeMajor }, mode };
};

const claimChecks = (
  browser: BrowserScrape | undefined,
  { managedProxy, random }: Dependencies,
): ClaimChecks => {
  const seed = () => seedOf(random(SEED_BYTES));

  if (browser === undefined) {
    return { seed };
  }

  return {
    capabilities: browser.capabilities,
    check: (row) =>
      row.record === undefined
        ? undefined
        : presentableRecord(
            { browserArgs: row.browserArgs, platform: row.platform, record: row.record },
            browser,
          ),
    seed,
    stickyId: managedProxy === undefined ? randomUUID : () => managedProxy.createSessionId(),
  };
};

type HeldVisit =
  | { readonly kind: "settled" }
  | { readonly kind: "member-retired"; readonly error: XrioError<"SESSION_UNAVAILABLE"> };

const SETTLED: HeldVisit = { kind: "settled" };

const retiredMember = (
  intent: ScrapeIntent,
  error: unknown,
): error is XrioError<"SESSION_UNAVAILABLE"> =>
  intent.session.kind === "pool" &&
  isXrioError(error, "SESSION_UNAVAILABLE") &&
  error.details.reason === "exit-changed";

const visitInHold = async (
  intent: ScrapeIntent,
  checks: ClaimChecks,
  deadline: Deadline,
  dependencies: Dependencies,
  answer: Answer,
): Promise<HeldVisit> => {
  const claimDeadline = deadline.boundTo(dependencies.closing, "client-closed");

  await using hold = await timeStage(
    "session",
    async () => await dependencies.sessions.hold(intent.session, checks, claimDeadline),
    claimDeadline,
  );

  const held = hold.bind(deadline);
  using _answerLifetime = settleAnswerOnAbort(answer, held);

  try {
    const context = { answer, capabilities: checks.capabilities, dependencies, held, hold, intent };
    const retryDeadline = held.boundTo(dependencies.closing, "client-closed");
    const retries = createRetries(intent.retries, retryDeadline, dependencies.retryRandom);
    await completeVisits(context, retries);

    return SETTLED;
  } catch (error) {
    if (retiredMember(intent, error)) {
      return { error, kind: "member-retired" };
    }

    answer.fail(scrapeError(error, held));

    return SETTLED;
  }
};

const visitUntilSettled = async (
  intent: ScrapeIntent,
  checks: ClaimChecks,
  deadline: Deadline,
  dependencies: Dependencies,
  answer: Answer,
): Promise<HeldVisit> => {
  const members = intent.session.kind === "pool" ? intent.session.size : 1;
  let visit = await visitInHold(intent, checks, deadline, dependencies, answer);

  // oxlint-disable no-await-in-loop -- A pool claims its next member only after the retired one was released.
  for (let tried = 1; visit.kind === "member-retired" && tried < members; tried += 1) {
    deadline.throwIfExpired();
    visit = await visitInHold(intent, checks, deadline, dependencies, answer);
  }
  // oxlint-enable no-await-in-loop

  return visit;
};

const coordinate = async (
  intent: ScrapeIntent,
  deadline: Deadline,
  dependencies: Dependencies,
  answer: Answer,
): Promise<void> => {
  reportSkippedCookies(intent.cookies.skipped);

  try {
    const browser = await sessionBrowser(intent, deadline, dependencies);
    const checks = claimChecks(browser, dependencies);
    const visit = await visitUntilSettled(intent, checks, deadline, dependencies, answer);

    if (visit.kind === "member-retired") {
      answer.fail(visit.error);
    }
  } catch (error) {
    answer.fail(scrapeError(error, deadline));
  } finally {
    answer.settleWithFallback();
  }
};

export const createScrapes = (
  dependencies: Omit<
    Dependencies,
    "random" | "retryRandom" | "closing" | "configuredProxy" | "managedProxy" | "proxyInfo"
  > & {
    readonly random?: Dependencies["random"];
    readonly retryRandom?: Dependencies["retryRandom"];
    readonly config?: Pick<ResolvedConfig, "proxy">;
    readonly proxyInfo?: Dependencies["proxyInfo"];
  },
): Scrapes => {
  const config = dependencies.config?.proxy;
  const proxy = config === undefined ? undefined : new ProxyManager(config);

  const closingSignal = new AbortController();

  const managers: Dependencies = {
    ...dependencies,
    closing: closingSignal.signal,
    configuredProxy: proxy === undefined ? undefined : parseProxy(proxy.getProxyConnectionString()),
    managedProxy: proxy,
    proxyInfo: dependencies.proxyInfo ?? lookupProxyInfo,
    random: dependencies.random ?? randomBytes,
    retryRandom: dependencies.retryRandom ?? Math.random,
  };

  const runs = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const assertOpen = () => {
    if (closed) {
      throw clientClosed();
    }
  };

  const start: Scrapes["start"] = (intent, deadline) => {
    assertOpen();

    const answer = createAnswer();

    const settled = inScrapeContext(randomUUID(), async () => {
      await coordinate(intent, deadline, managers, answer);
    });

    runs.add(settled);

    const forgetSettled = async () => {
      await settled;
      runs.delete(settled);
    };

    void forgetSettled();

    return { answer: answer.promise, settled };
  };

  const drain = async () => {
    await Promise.allSettled(runs);
    await managers.sources.close();
  };

  const close = async () => {
    closed = true;
    closingSignal.abort(clientClosed());
    managers.admission.close();
    closing ??= drain();

    await closing;
  };

  return { assertOpen, close, start };
};
