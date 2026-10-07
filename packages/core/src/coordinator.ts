import { randomBytes, randomUUID } from "node:crypto";

import type { Admission } from "./admission.ts";
import { createAnswer } from "./answer.ts";
import type { Answer } from "./answer.ts";
import type { XrioConfig } from "./config.ts";
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

interface VisitResult extends FinishedVisit {
  readonly revisit: boolean;
}

const recordOf = (outcome: ScrapeOutcome): FinishedVisit["record"] =>
  outcome.kind === "document" && outcome.document.identity.mode !== "http"
    ? outcome.document.identity.record
    : null;

const visitOnce = async (context: VisitContext, terminal: boolean): Promise<VisitResult> => {
  const { answer, dependencies, held, hold, intent } = context;

  await using slot = await timeStage(
    "queue",
    async () => await dependencies.admission.slotFor(intent.source, held),
    held,
  );

  const plan = await timeStage("identity", async () => await plannedVisit(context), held);
  let transferred = false;

  try {
    const visit = dependencies.sources.start(plan, slot, held);

    transferred = true;

    const outcome = await outcomeOf(visit.document, held);
    const revisit = !terminal && outcome.kind === "document" && hold.revisitWanted(outcome);

    answer.offer(outcome, !revisit);

    return { closed: await visit.closed, record: recordOf(outcome), revisit };
  } finally {
    if (!transferred && plan.kind === "browser") {
      await plan.fonts.settle(null);
    }
  }
};

const coordinate = async (
  intent: ScrapeIntent,
  deadline: Deadline,
  dependencies: Dependencies,
  answer: Answer,
): Promise<void> => {
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

    try {
      const context = { answer, dependencies, held, hold, intent };
      const first = await visitOnce(context, false);

      await hold.finish(first);

      if (first.revisit) {
        await hold.finish(await visitOnce(context, true));
      }
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
  dependencies: Omit<Dependencies, "random" | "configuredProxy" | "proxyInfo"> & {
    readonly random?: Dependencies["random"];
    readonly config?: XrioConfig;
    readonly proxyInfo?: Dependencies["proxyInfo"];
  },
): Scrapes => {
  const config = dependencies.config?.proxy;
  const proxy = config === undefined ? undefined : new ProxyManager(config);

  const managers: Dependencies = {
    ...dependencies,
    configuredProxy: proxy === undefined ? undefined : parseProxy(proxy.getProxyConnectionString()),
    proxyInfo: dependencies.proxyInfo ?? lookupProxyInfo,
    random: dependencies.random ?? randomBytes,
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
    managers.admission.close();
    closing ??= drain();

    await closing;
  };

  return { assertOpen, close, start };
};
