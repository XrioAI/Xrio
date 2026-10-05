import { randomBytes } from "node:crypto";

import type { Admission } from "./admission.ts";
import type { Deadline } from "./deadline.ts";
import { timeStage } from "./diagnostics.ts";
import { clientClosed } from "./errors.ts";
import { SEED_BYTES, seedOf } from "./humanizer/draws.ts";
import { readHostZone } from "./humanizer/host-zone.ts";
import { planIdentity } from "./humanizer/humanizer.ts";
import { presentedLocale } from "./humanizer/surfaces.ts";
import type { ScrapeIntent } from "./intent.ts";
import type { HeldDeadline } from "./lifetime.ts";
import { refuseRecordOverrides } from "./options.ts";
import { exitFactsFor, routeFor } from "./proxy/route.ts";
import type { SessionHold, SessionManager } from "./sessions/session.ts";
import type { FontEvidenceStore } from "./sources/browser/font-evidence.ts";
import type { HostFacts } from "./sources/browser/host-facts.ts";
import type { Sources, VisitPlan } from "./sources/visit.ts";
import type { SourceDocument } from "./types.ts";

type BrowserSource = Exclude<ScrapeIntent["source"], { mode: "http" }>;

type BrowserScrapeIntent = ScrapeIntent & { readonly source: BrowserSource };

interface ScrapeRun {
  readonly answer: Promise<SourceDocument>;
  readonly settled: Promise<void>;
}

export interface Scrapes {
  readonly assertOpen: () => void;
  readonly start: (intent: BrowserScrapeIntent, deadline: Deadline) => ScrapeRun;
  readonly close: () => Promise<void>;
}

interface Dependencies {
  readonly host: HostFacts;
  readonly sessions: SessionManager;
  readonly admission: Admission;
  readonly sources: Sources;
  readonly fonts: FontEvidenceStore;
  readonly random: (size: number) => Uint8Array;
}

interface VisitContext {
  readonly intent: BrowserScrapeIntent;
  readonly hold: SessionHold;
  readonly held: HeldDeadline;
  readonly dependencies: Dependencies;
}

const plannedVisit = async ({
  dependencies,
  held,
  hold,
  intent,
}: VisitContext): Promise<VisitPlan> => {
  const capabilities = await dependencies.host.snapshotFor(intent.source.browserPath, held);
  const scrape = { mode: intent.source.mode, pins: intent.identity };

  if (hold.device.kind === "record") {
    refuseRecordOverrides(hold.device.record, scrape);
  }

  const fonts = await dependencies.fonts.claim(
    intent.source.browserPath,
    capabilities,
    presentedLocale(intent.identity).tag,
    held,
  );

  try {
    const route = routeFor(intent.route);

    const identity = planIdentity({
      ...scrape,
      capabilities:
        fonts.evidence === undefined
          ? capabilities
          : { ...capabilities, fontEvidence: fonts.evidence },
      device: hold.device,
      exit: { facts: exitFactsFor(route), route: route.kind },
      hostZone: readHostZone(),
    });

    return { ...intent.source, capabilities, fonts, identity, kind: "browser", url: intent.url };
  } catch (error) {
    await fonts.settle(null);

    throw error;
  }
};

const visitOnce = async (
  context: VisitContext,
  answer: PromiseWithResolvers<SourceDocument>,
): Promise<void> => {
  const { dependencies, held, intent } = context;

  await using slot = await timeStage(
    "queue",
    async () => await dependencies.admission.slotFor(intent.source, held),
  );

  const plan = await timeStage("identity", async () => await plannedVisit(context));
  let transferred = false;

  try {
    const visit = dependencies.sources.start(plan, slot, held);

    transferred = true;

    try {
      answer.resolve(await visit.document);
    } catch (error) {
      answer.reject(error);
    }

    await visit.closed;
  } finally {
    if (!transferred) {
      await plan.fonts.settle(null);
    }
  }
};

const coordinate = async (
  intent: BrowserScrapeIntent,
  deadline: Deadline,
  dependencies: Dependencies,
  answer: PromiseWithResolvers<SourceDocument>,
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

    await visitOnce({ dependencies, held: hold.bind(deadline), hold, intent }, answer);
  } catch (error) {
    answer.reject(error);
  }
};

export const createScrapes = (
  dependencies: Omit<Dependencies, "random"> & { readonly random?: Dependencies["random"] },
): Scrapes => {
  const managers: Dependencies = { ...dependencies, random: dependencies.random ?? randomBytes };
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

    const answer = Promise.withResolvers<SourceDocument>();
    const settled = coordinate(intent, deadline, managers, answer);

    void Promise.allSettled([answer.promise]);
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
    closing ??= drain();

    await closing;
  };

  return { assertOpen, close, start };
};
