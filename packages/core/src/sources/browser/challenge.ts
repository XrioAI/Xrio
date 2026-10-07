import { challengeCandidate } from "../../blocks/classify.ts";
import type { BlockInput, ChallengeOutcome, ChallengeReport } from "../../blocks/classify.ts";
import type { Deadline } from "../../deadline.ts";
import type { ResponseDetails } from "../../types.ts";
import { documentKey } from "./documents.ts";
import { pollAfter } from "./poll.ts";
import type { DocumentHop } from "./port.ts";

const POLL_MS = 250;

const ROUND_BUDGET_MS = 20_000;

const MAX_ROUNDS = 3;

export const CAPTURE_RESERVE_MS = 1000;

export interface ChallengeDocuments {
  readonly documentLoaded: (deadline: Deadline) => Promise<DocumentHop>;
  readonly loadedDocument: () => DocumentHop | undefined;
  readonly responseOf: (document: DocumentHop) => ResponseDetails;
  readonly requestUrls: (document: DocumentHop) => readonly string[];
  readonly isCurrent: (document: DocumentHop) => boolean;
}

const inputOf = (
  documents: ChallengeDocuments,
  document: DocumentHop,
  html?: string,
): BlockInput => ({
  html,
  requestUrls: documents.requestUrls(document),
  response: documents.responseOf(document),
});

export interface ChallengeWait {
  readonly report: ChallengeReport | null;
  readonly lastDocument: DocumentHop;
}

interface RoundResult {
  readonly document: DocumentHop;
  readonly outcome: ChallengeOutcome | "next";
}

const waitForReplacement = async (
  documents: ChallengeDocuments,
  document: DocumentHop,
  deadline: Deadline,
): Promise<RoundResult> => {
  const budget = Math.max(
    0,
    Math.min(ROUND_BUDGET_MS, deadline.remainingMs() - CAPTURE_RESERVE_MS),
  );

  const end = deadline.clock.now() + budget;

  while (deadline.clock.now() < end) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- poll the injected clock until a loaded replacement appears.
    await pollAfter(Math.min(POLL_MS, end - deadline.clock.now()), deadline);
    const next = documents.loadedDocument();

    if (next !== undefined && documentKey(next) !== documentKey(document)) {
      return { document: next, outcome: "next" };
    }
  }

  return { document, outcome: budget < ROUND_BUDGET_MS ? "deadline" : "budget_exhausted" };
};

export const waitForChallenge = async (
  documents: ChallengeDocuments,
  deadline: Deadline,
  initial?: BlockInput,
  previous?: ChallengeReport | null,
): Promise<ChallengeWait> => {
  let document = await documents.documentLoaded(deadline);
  let candidate = challengeCandidate(initial ?? inputOf(documents, document));

  if (candidate === undefined) {
    return { lastDocument: document, report: previous ?? null };
  }

  const report: ChallengeReport = {
    outcome: "rounds_exhausted",
    rounds: [...(previous?.rounds ?? [])],
  };

  while (candidate !== undefined && report.rounds.length < MAX_ROUNDS) {
    const started = deadline.clock.now();
    // oxlint-disable-next-line eslint/no-await-in-loop -- each vendor challenge depends on the preceding document.
    const result = await waitForReplacement(documents, document, deadline);
    report.rounds.push({
      rule: candidate.rule,
      vendor: candidate.vendor,
      waitedMs: deadline.clock.now() - started,
    });
    ({ document } = result);

    if (result.outcome !== "next") {
      report.outcome = result.outcome;

      return { lastDocument: document, report };
    }

    candidate = challengeCandidate(inputOf(documents, document));
  }

  report.outcome = candidate === undefined ? "passed" : "rounds_exhausted";

  return { lastDocument: document, report };
};
