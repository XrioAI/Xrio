import { challengeCandidate } from "../../blocks/classify.ts";
import type {
  BlockEvidence,
  BlockInput,
  ChallengeOutcome,
  ChallengeReport,
} from "../../blocks/classify.ts";
import type { Deadline } from "../../deadline.ts";
import { pollAfter } from "../../poll.ts";
import type { ResponseDetails } from "../../types.ts";
import { documentKey } from "./documents.ts";
import type { DocumentHop, PageArea } from "./port.ts";

const POLL_MS = 250;

const ROUND_BUDGET_MS = 20_000;

const MAX_ROUNDS = 3;

const CHECKBOX_GRACE_MS = 6000;

const CHECKBOX_HANDOVER_MS = 3000;

const CHECKBOX_VENDOR = "cloudflare";

export const CAPTURE_RESERVE_MS = 1000;

interface Escalation {
  readonly check: RegExp;
  readonly captcha: RegExp;
}

const ESCALATIONS: readonly Escalation[] = [
  {
    captcha: /^https:\/\/geo\.captcha-delivery\.com\/captcha\//u,
    check: /^https:\/\/geo\.captcha-delivery\.com\/interstitial\//u,
  },
];

const escalatedIn = (urls: readonly string[]): boolean =>
  ESCALATIONS.some(({ captcha, check }) => {
    const checked = urls.findIndex((url) => check.test(url));

    return checked !== -1 && urls.slice(checked + 1).some((url) => captcha.test(url));
  });

export interface ChallengeCheckbox {
  readonly widget: string;
  readonly area: PageArea;
}

export interface ChallengeDocuments {
  readonly documentLoaded: (deadline: Deadline) => Promise<DocumentHop>;
  readonly loadedDocument: () => DocumentHop | undefined;
  readonly responseOf: (document: DocumentHop) => ResponseDetails;
  readonly requestUrls: (document: DocumentHop) => readonly string[];
  readonly isCurrent: (document: DocumentHop) => boolean;
  readonly currentHtml: (document: DocumentHop, deadline: Deadline) => Promise<string | undefined>;
  readonly currentCheckbox: (
    document: DocumentHop,
    deadline: Deadline,
  ) => Promise<ChallengeCheckbox | undefined>;
  readonly clickCheckbox: (
    document: DocumentHop,
    checkbox: ChallengeCheckbox,
    deadline: Deadline,
  ) => Promise<boolean>;
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
  readonly clicks: number;
}

interface RoundWindow {
  readonly start: number;
  readonly end: number;
}

class CheckboxClicks {
  readonly #documents: ChallengeDocuments;
  readonly #document: DocumentHop;
  readonly #roundEnd: number;
  readonly #clicked = new Set<string>();
  #dueAt: number;

  constructor(
    documents: ChallengeDocuments,
    document: DocumentHop,
    candidate: BlockEvidence,
    round: RoundWindow,
  ) {
    this.#documents = documents;
    this.#document = document;
    this.#roundEnd = round.end;
    this.#dueAt =
      candidate.vendor === CHECKBOX_VENDOR
        ? round.start + CHECKBOX_GRACE_MS
        : Number.POSITIVE_INFINITY;
  }

  get count(): number {
    return this.#clicked.size;
  }

  async clickWhenDue(deadline: Deadline): Promise<void> {
    if (!this.#isDue(deadline.clock.now())) {
      return;
    }

    const checkbox = await this.#documents.currentCheckbox(this.#document, deadline);

    if (checkbox === undefined || this.#clicked.has(checkbox.widget)) {
      return;
    }

    if (await this.#documents.clickCheckbox(this.#document, checkbox, deadline)) {
      this.#clicked.add(checkbox.widget);
      this.#dueAt = deadline.clock.now() + CHECKBOX_GRACE_MS;
    }
  }

  #isDue(now: number): boolean {
    return now >= this.#dueAt && this.#roundEnd - now >= CHECKBOX_HANDOVER_MS;
  }
}

type PageRead = "challenge" | "clear" | "unreadable";

const pageReadOf = (input: BlockInput): PageRead =>
  challengeCandidate(input) === undefined ? "clear" : "challenge";

const readPage = async (
  documents: ChallengeDocuments,
  document: DocumentHop,
  deadline: Deadline,
): Promise<PageRead> => {
  const html = await documents.currentHtml(document, deadline);

  return html === undefined ? "unreadable" : pageReadOf(inputOf(documents, document, html));
};

const readAtRoundStart = async (
  documents: ChallengeDocuments,
  document: DocumentHop,
  deadline: Deadline,
  initial?: BlockInput,
): Promise<PageRead> =>
  initial?.html === undefined ? await readPage(documents, document, deadline) : pageReadOf(initial);

const waitForReplacement = async (
  documents: ChallengeDocuments,
  document: DocumentHop,
  candidate: BlockEvidence,
  deadline: Deadline,
  initial?: BlockInput,
): Promise<RoundResult> => {
  const budget = Math.max(
    0,
    Math.min(ROUND_BUDGET_MS, deadline.remainingMs() - CAPTURE_RESERVE_MS),
  );

  const start = deadline.clock.now();
  const end = start + budget;
  const clicks = new CheckboxClicks(documents, document, candidate, { end, start });

  const watchesPage =
    (await readAtRoundStart(documents, document, deadline, initial)) === "challenge";

  while (deadline.clock.now() < end) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- poll the injected clock until a loaded replacement appears.
    await pollAfter(Math.min(POLL_MS, end - deadline.clock.now()), deadline);
    const next = documents.loadedDocument();

    if (next !== undefined && documentKey(next) !== documentKey(document)) {
      return { clicks: clicks.count, document: next, outcome: "next" };
    }

    if (escalatedIn(documents.requestUrls(document))) {
      return { clicks: clicks.count, document, outcome: "escalated" };
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- each tick judges the page after the previous read finishes.
    if (watchesPage && (await readPage(documents, document, deadline)) === "clear") {
      return { clicks: clicks.count, document, outcome: "passed_in_place" };
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- a click waits for the page the tick just judged.
    await clicks.clickWhenDue(deadline);
  }

  const outcome = budget < ROUND_BUDGET_MS ? "deadline" : "budget_exhausted";

  return { clicks: clicks.count, document, outcome };
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
    const report =
      previous?.outcome === "escalated" ? { ...previous, outcome: "passed" as const } : previous;

    return { lastDocument: document, report: report ?? null };
  }

  const report: ChallengeReport = {
    clicks: previous?.clicks ?? 0,
    outcome: "rounds_exhausted",
    reloads: previous?.reloads ?? 0,
    rounds: [...(previous?.rounds ?? [])],
  };

  let evidence = initial;

  while (candidate !== undefined && report.rounds.length < MAX_ROUNDS) {
    const started = deadline.clock.now();
    // oxlint-disable-next-line eslint/no-await-in-loop -- each vendor challenge depends on the preceding document.
    const result = await waitForReplacement(documents, document, candidate, deadline, evidence);
    evidence = undefined;
    report.clicks += result.clicks;
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
