import { createAdmission } from "../admission.ts";
import { defaultCacheDir } from "../cache-dir.ts";
import { createScrapes } from "../coordinator.ts";
import type { Deadline } from "../deadline.ts";
import type { IdentityIntent } from "../humanizer/intent.ts";
import type { HeldDeadline } from "../lifetime.ts";
import { anonymousSessions } from "../sessions/session.ts";
import type { SessionManager } from "../sessions/session.ts";
import type { Closed, RetireSteps } from "../sources/browser/chrome-scope.ts";
import { createFontEvidenceStore } from "../sources/browser/font-evidence.ts";
import { hostFactsFor } from "../sources/browser/host-facts.ts";
import type { HostFacts } from "../sources/browser/host-facts.ts";
import type { BrowserDriver } from "../sources/browser/port.ts";
import { createSources } from "../sources/source.ts";
import type { Sources } from "../sources/visit.ts";
import type { ProxyEndpoint, SourceDocument, WaitFor } from "../types.ts";

type Dependencies = Parameters<typeof createScrapes>[0];

export type PlanningDependencies = Partial<
  Pick<Dependencies, "fonts" | "sessions" | "random" | "proxyInfo">
> & {
  readonly host?: HostFacts["snapshotFor"];
  readonly retire?: Partial<RetireSteps>;
};

interface TestScrape {
  readonly browserArgs: readonly string[];
  readonly browserPath: string;
  readonly deadline: Deadline;
  readonly pins: IdentityIntent;
  readonly mode: "headed" | "headless";
  readonly proxy?: ProxyEndpoint;
  readonly url: URL;
  readonly waitFor?: WaitFor;
}

export interface PlannedScrapes {
  readonly visit: (request: TestScrape) => {
    document: Promise<SourceDocument>;
    closed: Promise<Closed>;
  };
  readonly capture: (request: TestScrape) => Promise<SourceDocument>;
  readonly close: () => Promise<void>;
}

type Session = Parameters<SessionManager["hold"]>[0];

export const plannedScrapes = (
  driver: BrowserDriver,
  capacity = 1,
  overrides: PlanningDependencies = {},
): PlannedScrapes => {
  const runtime = createSources(driver, overrides.retire);
  const sessions = overrides.sessions ?? anonymousSessions();
  const sessionOf = new WeakMap<HeldDeadline, Session>();
  const closedOf = new WeakMap<Session, Promise<Closed>>();

  const sources: Sources = {
    close: runtime.close,
    start: (plan, slot, deadline) => {
      const visit = runtime.start(plan, slot, deadline);
      const session = sessionOf.get(deadline);

      if (session !== undefined) {
        closedOf.set(session, visit.closed);
      }

      return visit;
    },
  };

  const scrapes = createScrapes({
    admission: createAdmission(capacity),
    comparisonBinary: undefined,
    fonts: overrides.fonts ?? createFontEvidenceStore(),
    host:
      overrides.host === undefined
        ? hostFactsFor(defaultCacheDir())
        : { snapshotFor: overrides.host },
    proxyInfo: overrides.proxyInfo,
    random: overrides.random,
    sessions: {
      hold: async (intent, checks, deadline) => {
        const hold = await sessions.hold(intent, checks, deadline);

        return {
          ...hold,
          bind: (request) => {
            const held = hold.bind(request);

            sessionOf.set(held, intent);

            return held;
          },
        };
      },
    },
    sources,
  });

  const visit: PlannedScrapes["visit"] = ({ deadline, ...request }) => {
    const session: Session = { kind: "anonymous" };

    const run = scrapes.start(
      {
        cookies: { seeds: [], skipped: [] },
        format: "html",
        identity: request.pins,
        retries: 0,
        route: request.proxy,
        session,
        signal: undefined,
        source: {
          browserArgs: request.browserArgs,
          browserPath: request.browserPath,
          mode: request.mode,
          waitFor: request.waitFor,
        },
        timeoutMs: deadline.remainingMs(),
        url: request.url,
      },
      deadline,
    );

    const closed = async (): Promise<Closed> => {
      await run.settled;

      return (await closedOf.get(session)) ?? { exited: true };
    };

    return { closed: closed(), document: run.answer };
  };

  const capture: PlannedScrapes["capture"] = async (request) => {
    const run = visit(request);

    try {
      return await run.document;
    } finally {
      await run.closed;
    }
  };

  return { capture, close: scrapes.close, visit };
};
