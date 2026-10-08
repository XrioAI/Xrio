import { randomBytes, randomUUID } from "node:crypto";

import type { Admission } from "./admission.ts";
import { createAnswer } from "./answer.ts";
import type { Answer } from "./answer.ts";
import type { ResolvedConfig } from "./config.ts";
import type { Deadline } from "./deadline.ts";
import { inScrapeContext, timeStage } from "./diagnostics.ts";
import { clientClosed } from "./errors.ts";
import type { HostCapabilities } from "./humanizer/contracts.ts";
import { SEED_BYTES, seedOf } from "./humanizer/draws.ts";
import { readHostZone } from "./humanizer/host-zone.ts";
import { httpIdentity, planIdentity } from "./humanizer/humanizer.ts";
import { identityForVisit, presentedLocale } from "./humanizer/surfaces.ts";
import type { ScrapeIntent } from "./intent.ts";
import type { HeldDeadline } from "./lifetime.ts";
import { parseProxy, refuseRecordOverrides } from "./options.ts";
import { outcomeOf, scrapeError } from "./outcome.ts";
import type { ScrapeOutcome } from "./outcome.ts";
import { lookupProxyInfo } from "./proxy/info.ts";
import { ProxyManager } from "./proxy/manager.ts";
import { exitFactsFor, routeFor } from "./proxy/route.ts";
import { createRetries } from "./retries.ts";
import type { Retries } from "./retries.ts";
import { reportSkippedCookies } from "./seed-cookies.ts";
import type { SessionHold, SessionManager } from "./sessions/session.ts";
import type { FontEvidenceStore } from "./sources/browser/font-evidence.ts";
import type { HostFacts } from "./sources/browser/host-facts.ts";
import type { FinishedVisit, Sources, VisitPlan } from "./sources/visit.ts";
import type { ProxyEndpoint, SourceDocument } from "./types.ts";

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
  readonly sessions: SessionManager;
  readonly admission: Admission;
  readonly sources: Sources;
  readonly fonts: FontEvidenceStore;
  readonly random: (size: number) => Uint8Array;
  readonly retryRandom: () => number;
  readonly closing: AbortSignal;
  readonly configuredProxy: ProxyEndpoint | undefined;
  readonly proxyInfo: typeof lookupProxyInfo;
}

interface VisitContext {
  readonly answer: Answer;
  readonly intent: ScrapeIntent;
  readonly hold: SessionHold;
  readonly held: HeldDeadline;
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

  const route = routeFor(proxy);
  const observation = proxy === undefined ? undefined : await dependencies.proxyInfo(proxy, held);

  held.throwIfExpired();
  const pins = identityForVisit(intent.identity, hold.device, observation?.locale);

  const capabilities = await dependencies.host.snapshotFor(intent.source.browserPath, held);
  const scrape = { mode: intent.source.mode, pins };

  if (hold.device.kind === "record") {
    refuseRecordOverrides(hold.device.record, { ...scrape, pins: intent.identity });
  }

  const fonts = await dependencies.fonts.claim(
    intent.source.browserPath,
    capabilities,
    presentedLocale(pins).tag,
    held,
  );

  try {
    const identity = planIdentity({
      ...scrape,
      capabilities:
        fonts.evidence === undefined
          ? capabilities
          : { ...capabilities, fontEvidence: fonts.evidence },
      device: hold.device,
      exit: { facts: exitFactsFor(route, observation), route: route.kind },
      followExit: route.kind === "proxy",
      hostZone: readHostZone(),
    });

    return {
      ...intent.source,
      capabilities,
      cookies: intent.cookies.seeds,
      fonts,
      identity,
      kind: "browser",
      proxy,
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
  const { answer, dependencies, held, intent } = context;

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

    if (next.kind !== "retry") {
      answer.offer(outcome, next.kind === "complete");
    }

    return { closed: await visit.closed, next, outcome, record: recordOf(outcome) };
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

const coordinate = async (
  intent: ScrapeIntent,
  deadline: Deadline,
  dependencies: Dependencies,
  answer: Answer,
): Promise<void> => {
  reportSkippedCookies(intent.cookies.skipped);

  try {
    await using hold = await dependencies.sessions.hold(
      intent.session,
      {
        identity: intent.identity,
        seed: () => seedOf(dependencies.random(SEED_BYTES)),
        source: intent.source,
      },
      deadline,
    );

    const held = hold.bind(deadline);
    using _answerLifetime = settleAnswerOnAbort(answer, held);

    try {
      const context = { answer, dependencies, held, hold, intent };
      const retryDeadline = held.boundTo(dependencies.closing, "client-closed");
      const retries = createRetries(intent.retries, retryDeadline, dependencies.retryRandom);
      await completeVisits(context, retries);
    } catch (error) {
      answer.fail(scrapeError(error, held));
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
    "random" | "retryRandom" | "closing" | "configuredProxy" | "proxyInfo"
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
