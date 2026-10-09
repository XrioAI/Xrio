import type { Deadline } from "../deadline.ts";
import type { Seed } from "../humanizer/contracts.ts";
import type { IdentityContext } from "../humanizer/surfaces.ts";
import type { ScrapeIntent } from "../intent.ts";
import { HeldDeadline } from "../lifetime.ts";
import type { ScrapeOutcome } from "../outcome.ts";
import type { FinishedVisit } from "../sources/visit.ts";

export interface SessionHold extends AsyncDisposable {
  readonly device: IdentityContext["device"];
  readonly bind: (deadline: Deadline) => HeldDeadline;
  readonly revisitWanted: (outcome: ScrapeOutcome) => boolean;
  readonly finish: (visit: FinishedVisit) => Promise<void>;
}

interface ClaimChecks {
  readonly seed: () => Seed;
  readonly identity: ScrapeIntent["identity"];
  readonly source: ScrapeIntent["source"];
}

export interface SessionManager {
  readonly hold: (
    intent: ScrapeIntent["session"],
    checks: ClaimChecks,
    deadline: Deadline,
  ) => Promise<SessionHold>;
}

export const anonymousSessions = (): SessionManager => ({
  hold: async (_intent, checks, deadline) => {
    deadline.throwIfExpired();
    const ownership = new AbortController();
    let released = false;

    return await Promise.resolve({
      [Symbol.asyncDispose]: async () => {
        if (!released) {
          released = true;
          ownership.abort(new Error("The anonymous hold was released."));
        }

        await Promise.resolve();
      },
      bind: (request) => new HeldDeadline(request, ownership.signal),
      device: { kind: "fresh", seed: checks.seed() },
      finish: async () => {
        await Promise.resolve();
      },
      revisitWanted: () => false,
    });
  },
});
