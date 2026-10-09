import type { Deadline } from "../../deadline.ts";
import { invalidOptions, XrioError } from "../../errors.ts";
import { pollAfter } from "../../poll.ts";
import type { ResponseDetails, WaitFor } from "../../types.ts";
import { CAPTURE_RESERVE_MS } from "./challenge.ts";
import type { ChallengeDocuments } from "./challenge.ts";
import { documentKey } from "./documents.ts";
import { DriverError } from "./port.ts";
import type { DocumentHop, DriverBrowser } from "./port.ts";

const HOLD_MS = 500;

const POLL_MS = 250;

type SelectorReply = "matched" | "absent" | "invalid";

const isSelectorReply = (value: unknown): value is SelectorReply =>
  value === "matched" || value === "absent" || value === "invalid";

const selectorReply = async (
  browser: DriverBrowser,
  selector: string,
  deadline: Deadline,
): Promise<SelectorReply> => {
  const expression = `(() => {
    try { return document.querySelectorAll(${JSON.stringify(selector)}).length > 0 ? "matched" : "absent"; }
    catch (error) { if (error.name === "SyntaxError") return "invalid"; throw error; }
  })()`;

  try {
    return await browser.evaluateIsolated(expression, isSelectorReply, deadline);
  } catch (error) {
    if (error instanceof DriverError && error.reason.kind === "document-replaced") {
      return "absent";
    }

    throw error;
  }
};

interface SelectorHold {
  readonly document: DocumentHop;
  readonly since: number;
}

const holdFor = (
  document: DocumentHop | undefined,
  matched: boolean,
  previous: SelectorHold | undefined,
  now: number,
): SelectorHold | undefined => {
  if (document === undefined || !matched) {
    return undefined;
  }

  if (previous !== undefined && documentKey(previous.document) === documentKey(document)) {
    return previous;
  }

  return { document, since: now };
};

export const waitForSelector = async (
  browser: DriverBrowser,
  documents: ChallengeDocuments,
  { selector }: WaitFor,
  deadline: Deadline,
  capture: () => Promise<ResponseDetails & { html: string }>,
): Promise<DocumentHop> => {
  let held: SelectorHold | undefined;

  for (;;) {
    deadline.throwIfExpired();
    const document = documents.loadedDocument();

    const reply =
      // oxlint-disable-next-line eslint/no-await-in-loop -- each sample follows the preceding clock tick.
      document === undefined ? "absent" : await selectorReply(browser, selector, deadline);

    if (reply === "invalid") {
      throw invalidOptions(`Invalid waitFor selector: ${selector}`);
    }

    const matched = reply === "matched" && document !== undefined && documents.isCurrent(document);
    held = holdFor(document, matched, held, deadline.clock.now());

    if (held !== undefined && deadline.clock.now() - held.since >= HOLD_MS) {
      return held.document;
    }

    if (deadline.remainingMs() <= CAPTURE_RESERVE_MS) {
      break;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- the next selector observation is scheduled on the injected clock.
    await pollAfter(
      Math.min(POLL_MS, Math.max(0, deadline.remainingMs() - CAPTURE_RESERVE_MS)),
      deadline,
    );
  }

  const details = await capture();
  deadline.throwIfExpired();
  throw new XrioError(
    "WAIT_FOR_TIMEOUT",
    `The selector ${selector} did not hold for ${HOLD_MS} ms.`,
    {
      details: { ...details, selector },
    },
  );
};
