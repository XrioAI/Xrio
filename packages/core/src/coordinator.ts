import { randomBytes, randomUUID } from "node:crypto";

import type { Admission } from "./admission.ts";
import { createAnswer } from "./answer.ts";
import type { Answer } from "./answer.ts";
import type { ResolvedConfig } from "./config.ts";
import type { Deadline } from "./deadline.ts";
import { inScrapeContext, timeStage } from "./diagnostics.ts";
import { clientClosed, isXrioError, sessionUnavailable } from "./errors.ts";
import type { XrioError } from "./errors.ts";
import { deviceDigest, identityPlanRecord } from "./humanizer/contracts.ts";
import type { HostCapabilities, Seed } from "./humanizer/contracts.ts";
import { SEED_BYTES, seedOf } from "./humanizer/draws.ts";
import { readHostZone } from "./humanizer/host-zone.ts";
import { httpIdentity, planIdentity } from "./humanizer/humanizer.ts";
import { presentableRecord } from "./humanizer/read-record.ts";
import { identityForVisit, presentedLocale } from "./humanizer/surfaces.ts";
import type { ScrapeIntent } from "./intent.ts";
import type { HeldDeadline } from "./lifetime.ts";
import { outcomeOf, scrapeError } from "./outcome.ts";
import type { ScrapeOutcome } from "./outcome.ts";
import { proxyExits } from "./proxy/exit.ts";
import type { ProxyExits } from "./proxy/exit.ts";
import { lookupProxyInfo } from "./proxy/info.ts";
import type { ProxyObservation } from "./proxy/info.ts";
import { ProxyManager } from "./proxy/manager.ts";
import { startRelay } from "./proxy/relay.ts";
import type { Relay } from "./proxy/relay.ts";
import { exitFactsFor, routeFor } from "./proxy/route.ts";
import { bindSessionExit, firstExitProxy } from "./proxy/session-exit.ts";
import { createRetries } from "./retries.ts";
import type { Retries } from "./retries.ts";
import { reportSkippedCookies } from "./seed-cookies.ts";
import type { ClaimChecks, SessionHold, SessionManager } from "./sessions/session.ts";
import type { FontEvidenceStore } from "./sources/browser/font-evidence.ts";
import type { HostFacts } from "./sources/browser/host-facts.ts";
import type { AttemptLog, FinishedVisit, SiteVisit, Sources, VisitPlan } from "./sources/visit.ts";
import type { AttemptReport, ProxyEndpoint, SessionSummary, SourceDocument } from "./types.ts";

interface ScrapeRun {
  readonly answer: Promise<SourceDocument>;
  readonly attempts: () => AttemptReport;
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
  readonly exits: ProxyExits;
  readonly managedProxy: ProxyManager | undefined;
  readonly proxyInfo: (proxy: ProxyEndpoint, deadline: Deadline) => Promise<ProxyObservation>;
}

interface VisitContext {
  readonly answer: Answer;
  readonly attempts: AttemptReport;
  readonly intent: ScrapeIntent;
  readonly hold: SessionHold;
  readonly held: HeldDeadline;
  readonly capabilities: HostCapabilities | undefined;
  readonly dependencies: Dependencies;
}

type ScrapeReply = Pick<VisitContext, "answer" | "attempts">;

interface Visitor {
  readonly proxy: ProxyEndpoint | undefined;
  readonly device: SessionHold["device"];
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

const exitRouteOf = (
  { dependencies, hold, intent }: VisitContext,
  proxy: ProxyEndpoint | undefined,
) => ({
  binding: hold.binding,
  drawStickyId: hold.drawStickyId,
  manager: intent.route === undefined ? dependencies.managedProxy : undefined,
  observe: dependencies.proxyInfo,
  proxy,
});

const sessionExit = async (context: VisitContext, proxy: ProxyEndpoint | undefined) => {
  const { held, hold } = context;
  const exit = await bindSessionExit(exitRouteOf(context, proxy), held);

  if (exit.kind === "changed") {
    await hold.retire();
    throw sessionUnavailable("exit-changed", "The session's exit left its region.");
  }

  return exit;
};

interface PredialedRelay extends AsyncDisposable {
  readonly relayFor: (plan: VisitPlan) => Promise<Relay | undefined>;
}

const predialedRelay = async (
  { held, intent }: VisitContext,
  expected: ProxyEndpoint | undefined,
): Promise<PredialedRelay> => {
  const relayThrough = async (proxy: ProxyEndpoint | undefined) =>
    intent.source.mode === "http" || proxy === undefined
      ? undefined
      : { proxy, relay: await startRelay(proxy, held, "loopback", intent.url) };

  let current = await relayThrough(expected);

  const close = async () => {
    const closing = current;

    current = undefined;
    await closing?.relay[Symbol.asyncDispose]();
  };

  return {
    [Symbol.asyncDispose]: close,
    relayFor: async ({ proxy }) => {
      if (current?.proxy.url !== proxy?.url) {
        await close();
        current = await relayThrough(proxy);
      }

      return current?.relay;
    },
  };
};

const plannedVisit = async (
  context: VisitContext,
  { device, proxy }: Visitor,
): Promise<VisitPlan> => {
  const { dependencies, held, hold, intent } = context;

  if (intent.source.mode === "http") {
    return {
      capabilities: await comparisonFacts(context),
      cookies: intent.cookies.seeds,
      headers: intent.source.headers,
      identity: httpIdentity(identityForVisit(intent.identity, device)),
      kind: "http",
      proxy,
      url: intent.url,
    };
  }

  const exit = await sessionExit(context, proxy);
  const route = routeFor(exit.proxy);
  const { observation } = exit;

  held.throwIfExpired();
  const pins = identityForVisit(intent.identity, device, observation?.locale);

  const capabilities =
    context.capabilities ??
    (await dependencies.host.snapshotFor(intent.source.browserPath, held, intent.source.mode));

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
      device,
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
  | { readonly kind: "retry"; readonly delayMs: number }
  | { readonly kind: "fresh-exit"; readonly delayMs: 0; readonly route: ProxyEndpoint };

interface VisitResult extends FinishedVisit {
  readonly next: Continuation;
  readonly answered: ScrapeOutcome;
}

interface VisitPlanner {
  readonly expectedProxy: () => ProxyEndpoint | undefined;
  readonly plan: () => Promise<VisitPlan>;
}

const planVisits = (context: VisitContext, visitor: Visitor): VisitPlanner => {
  let frozen: VisitPlan | undefined;

  const plan = async () => {
    if (frozen === undefined) {
      frozen = await plannedVisit(context, visitor);

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

  return {
    expectedProxy: () =>
      frozen === undefined ? firstExitProxy(exitRouteOf(context, visitor.proxy)) : frozen.proxy,
    plan,
  };
};

const continuationFor = (
  outcome: ScrapeOutcome,
  context: VisitContext,
  terminal: boolean,
  retries: Retries,
  route: ProxyEndpoint | undefined,
): Continuation => {
  if (outcome.kind === "failed") {
    const delayMs = retries.next(outcome.error);

    return delayMs === undefined ? { kind: "complete" } : { delayMs, kind: "retry" };
  }

  const freshExit = retries.freshExitAfter(outcome.document.block, route);

  if (freshExit !== undefined) {
    return { delayMs: 0, kind: "fresh-exit", route: freshExit };
  }

  return !terminal && context.hold.revisitWanted(outcome)
    ? { kind: "revisit" }
    : { kind: "complete" };
};

const replayedDigest = ({ device }: SessionHold): string | null =>
  device.kind === "record" ? deviceDigest(device.record) : null;

const attemptOf = (
  { hold, intent }: VisitContext,
  plan: VisitPlan | undefined,
  outcome: ScrapeOutcome,
): AttemptLog => {
  const browser = plan?.kind === "browser" ? plan : undefined;

  const launched = {
    argv: null,
    exitAddress: browser?.exitAddress ?? null,
    plan: browser === undefined ? null : identityPlanRecord(browser.identity),
    proxyUrl: plan?.proxy?.url ?? null,
    site: intent.url.hostname,
    url: intent.url.href,
  };

  if (outcome.kind === "failed") {
    return {
      ...launched,
      challengeOutcome: null,
      challengeRules: [],
      deviceDigest: replayedDigest(hold),
      errorCode: isXrioError(outcome.error) ? outcome.error.code : null,
      outcome: "failed",
      status: null,
      vendor: null,
    };
  }

  const { block, identity, status } = outcome.document;

  return {
    ...launched,
    challengeOutcome: block.challenge?.outcome ?? null,
    challengeRules: block.challenge?.rounds.map((round) => round.rule) ?? [],
    deviceDigest: identity.mode === "http" ? null : deviceDigest(identity.record),
    errorCode: null,
    outcome: block.verdict,
    status,
    vendor: block.vendor,
  };
};

const siteVisitOf = (attempt: AttemptLog): SiteVisit | undefined =>
  attempt.outcome === "failed" || attempt.deviceDigest === null
    ? undefined
    : {
        challengeOutcome: attempt.challengeOutcome,
        challengeRules: attempt.challengeRules,
        deviceDigest: attempt.deviceDigest,
        exitAddress: attempt.exitAddress,
        site: attempt.site,
        vendor: attempt.vendor,
        verdict: attempt.outcome,
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
  readonly plan: VisitPlan | undefined;

  constructor(failure: Error, plan: VisitPlan | undefined) {
    super(failure.message, { cause: failure });
    this.failure = failure;
    this.plan = plan;
  }
}

const startAttempt = async <Result>(
  start: () => Result | Promise<Result>,
  held: HeldDeadline,
  plan?: VisitPlan,
): Promise<Result> => {
  try {
    return await start();
  } catch (error) {
    throw new AttemptStartError(scrapeError(error, held), plan);
  }
};

const visitOnce = async (
  context: VisitContext,
  terminal: boolean,
  retries: Retries,
  planner: VisitPlanner,
): Promise<VisitResult> => {
  const { answer, attempts, dependencies, held, hold, intent } = context;

  attempts.total += 1;

  await using slot = await startAttempt(
    async () =>
      await timeStage(
        "queue",
        async () => await dependencies.admission.slotFor(intent.source, held),
        held,
      ),
    held,
  );

  await using predialed = await startAttempt(
    async () => await predialedRelay(context, planner.expectedProxy()),
    held,
  );

  const plan = await startAttempt(
    async () => await timeStage("identity", planner.plan, held),
    held,
  );

  let transferred = false;

  try {
    const relay = await startAttempt(async () => await predialed.relayFor(plan), held, plan);

    const visit = await startAttempt(
      () => dependencies.sources.start(plan, slot, held, relay),
      held,
      plan,
    );

    transferred = true;

    const outcome = await outcomeOf(visit.document, held);
    const next = continuationFor(outcome, context, terminal, retries, plan.proxy);
    const attempt = attemptOf(context, plan, outcome);
    const siteVisit = siteVisitOf(attempt);

    const answered = withSession(
      outcome,
      siteVisit === undefined || plan.kind !== "browser"
        ? undefined
        : hold.summary(siteVisit, plan),
    );

    if (next.kind !== "retry") {
      answer.offer(answered, next.kind === "complete");
    }

    const record = recordOf(outcome);
    const closed = await visit.closed;

    return {
      ...attempt,
      answered,
      argv: await visit.argv,
      binding: record === null || plan.kind !== "browser" ? undefined : plan.sessionBinding,
      browserArgs: plan.kind === "browser" ? plan.browserArgs : [],
      closed,
      next,
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
  planner: VisitPlanner,
): Promise<VisitResult> => {
  for (;;) {
    try {
      return await visitOnce(context, terminal, retries, planner);
    } catch (error) {
      if (!(error instanceof AttemptStartError)) {
        throw error;
      }

      const { failure, plan } = error;

      await context.hold.logAttempt(attemptOf(context, plan, { error: failure, kind: "failed" }));

      const delayMs = retries.next(failure);

      if (delayMs === undefined || !(await retries.wait(delayMs))) {
        throw failure;
      }
    }
  }
};

const firstVisitor = ({ dependencies, hold, intent }: VisitContext): Visitor => ({
  device: hold.device,
  proxy: intent.route ?? dependencies.exits.current(),
});

const drawnSeed = (random: Dependencies["random"]): Seed => seedOf(random(SEED_BYTES));

const visitorBehind = (
  proxy: ProxyEndpoint,
  { device }: Visitor,
  { random }: Dependencies,
): Visitor => ({
  device: device.kind === "record" ? device : { kind: "fresh", seed: drawnSeed(random) },
  proxy,
});

const completeVisits = async (context: VisitContext, retries: Retries): Promise<void> => {
  let terminal = false;
  let visitor = firstVisitor(context);
  let planner = planVisits(context, visitor);

  for (;;) {
    const visit = await visitAfterStartFailures(context, terminal, retries, planner);

    await context.hold.finish(visit);

    if (visit.next.kind === "complete") {
      break;
    }

    if (visit.next.kind === "revisit") {
      terminal = true;
      planner = planVisits(context, visitor);
      continue;
    }

    if (!visit.closed.exited || !(await retries.wait(visit.next.delayMs))) {
      context.answer.offer(visit.answered, true);
      break;
    }

    if (visit.next.kind === "fresh-exit") {
      visitor = visitorBehind(visit.next.route, visitor, context.dependencies);
      planner = planVisits(context, visitor);
      context.attempts.freshExits += 1;
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
  const capabilities = await host.snapshotFor(browserPath, deadline, mode);
  const chromeMajor = await host.chromeMajorFor(browserPath, capabilities, deadline);

  return { browserArgs, capabilities: { ...capabilities, chromeMajor }, mode };
};

const claimChecks = (
  browser: BrowserScrape | undefined,
  { managedProxy, random }: Dependencies,
): ClaimChecks => {
  const seed = () => drawnSeed(random);

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

const NO_FRESH_EXITS: Pick<ProxyExits, "freshExitAfter"> = {
  freshExitAfter: (): undefined => undefined,
};

const freshExitsFor = (
  { session }: ScrapeIntent,
  { exits }: Dependencies,
): Pick<ProxyExits, "freshExitAfter"> => (session.kind === "anonymous" ? exits : NO_FRESH_EXITS);

const visitInHold = async (
  intent: ScrapeIntent,
  checks: ClaimChecks,
  deadline: Deadline,
  dependencies: Dependencies,
  { answer, attempts }: ScrapeReply,
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
    const context = {
      answer,
      attempts,
      capabilities: checks.capabilities,
      dependencies,
      held,
      hold,
      intent,
    };

    const retryDeadline = held.boundTo(dependencies.closing, "client-closed");

    const retries = createRetries(
      intent.retries,
      retryDeadline,
      dependencies.retryRandom,
      freshExitsFor(intent, dependencies),
    );

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
  reply: ScrapeReply,
): Promise<HeldVisit> => {
  const members = intent.session.kind === "pool" ? intent.session.size : 1;
  let visit = await visitInHold(intent, checks, deadline, dependencies, reply);

  // oxlint-disable no-await-in-loop -- A pool claims its next member only after the retired one was released.
  for (let tried = 1; visit.kind === "member-retired" && tried < members; tried += 1) {
    deadline.throwIfExpired();
    visit = await visitInHold(intent, checks, deadline, dependencies, reply);
  }
  // oxlint-enable no-await-in-loop

  return visit;
};

const coordinate = async (
  intent: ScrapeIntent,
  deadline: Deadline,
  dependencies: Dependencies,
  reply: ScrapeReply,
): Promise<void> => {
  const { answer } = reply;

  reportSkippedCookies(intent.cookies.skipped);

  try {
    const browser = await sessionBrowser(intent, deadline, dependencies);
    const checks = claimChecks(browser, dependencies);
    const visit = await visitUntilSettled(intent, checks, deadline, dependencies, reply);

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
    "random" | "retryRandom" | "closing" | "exits" | "managedProxy" | "proxyInfo"
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
    exits: proxyExits(proxy),
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
    const attempts: AttemptReport = { freshExits: 0, total: 0 };

    const settled = inScrapeContext(randomUUID(), async () => {
      await coordinate(intent, deadline, managers, { answer, attempts });
    });

    runs.add(settled);

    const forgetSettled = async () => {
      await settled;
      runs.delete(settled);
    };

    void forgetSettled();

    return { answer: answer.promise, attempts: () => ({ ...attempts }), settled };
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
