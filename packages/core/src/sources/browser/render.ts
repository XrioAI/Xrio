import { classifyResponse, challengeCandidate } from "../../blocks/classify.ts";
import type { BlockInput, ChallengeOutcome, ChallengeReport } from "../../blocks/classify.ts";
import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { XrioError } from "../../errors.ts";
import type { Relay } from "../../proxy/relay.ts";
import type { ResponseDetails, SourceDocument, WaitFor } from "../../types.ts";
import { isHtmlContentType, unsupportedContentType } from "../content-type.ts";
import { networkFailure } from "../net-error.ts";
import { waitForChallenge } from "./challenge.ts";
import type { ChallengeWait } from "./challenge.ts";
import {
  currentDocument,
  documentKey,
  documentResponse,
  downloadResponse,
  emptyDocuments,
  MAX_REQUEST_URLS,
  rawHeadersOf,
  recordDocumentEvent,
  requestUrlsOf,
} from "./documents.ts";
import { DriverError } from "./port.ts";
import type { DocumentHop, DriverBrowser, DriverErrorReason } from "./port.ts";
import { waitForSelector } from "./wait-for.ts";

const SLICE_CODE_UNITS = 4 * 1024 * 1024;

const MAX_CAPTURE_CODE_UNITS = 32 * 1024 * 1024;

const CAPTURE_EXPRESSION = `(() => {
  const root = document.documentElement;
  const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "";
  const html = root ? doctype + root.outerHTML : "";

  if (html.length <= ${SLICE_CODE_UNITS}) {
    return html;
  }

  if (html.length > ${MAX_CAPTURE_CODE_UNITS}) {
    return { tooLarge: html.length };
  }

  const key = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join("");

  globalThis[key] = html;

  return { key, length: html.length, slices: Math.ceil(html.length / ${SLICE_CODE_UNITS}) };
})()`;

const sliceExpression = (key: string, index: number, isLast: boolean): string => `(() => {
  const key = ${JSON.stringify(key)};
  const html = globalThis[key];

  if (${isLast}) {
    delete globalThis[key];
  }

  return typeof html === "string"
    ? html.slice(${index * SLICE_CODE_UNITS}, ${(index + 1) * SLICE_CODE_UNITS})
    : null;
})()`;

interface TooLarge {
  tooLarge: number;
}

interface Parked {
  key: string;
  length: number;
  slices: number;
}

const isHtml = (value: unknown): value is string => typeof value === "string";

const isTooLarge = (value: unknown): value is TooLarge =>
  typeof value === "object" &&
  value !== null &&
  "tooLarge" in value &&
  typeof value.tooLarge === "number";

const isParked = (value: unknown): value is Parked =>
  typeof value === "object" &&
  value !== null &&
  "key" in value &&
  typeof value.key === "string" &&
  "length" in value &&
  typeof value.length === "number" &&
  "slices" in value &&
  typeof value.slices === "number";

const isCaptureReply = (value: unknown): value is string | TooLarge | Parked =>
  isHtml(value) || isTooLarge(value) || isParked(value);

const isSlice = (value: unknown): value is string | null => value === null || isHtml(value);

const COMMITTED_ERROR_PAGE = "net::ERR_HTTP_RESPONSE_CODE_FAILURE";

const PROXY_NET_ERROR = /^net::ERR_(?:PROXY|TUNNEL)_/u;

type RelayFailures = Pick<Relay, "failureFor"> | undefined;

const browserCrashed = (cause?: unknown): XrioError =>
  new XrioError("BROWSER_CRASHED", "The browser or its renderer died mid-scrape.", {
    cause,
    details: undefined,
  });

const isDriverFailure = <Kind extends DriverErrorReason["kind"]>(
  error: unknown,
  kind: Kind,
): error is DriverError & { reason: Extract<DriverErrorReason, { kind: Kind }> } =>
  error instanceof DriverError && error.reason.kind === kind;

class PageTracker {
  #state = emptyDocuments();
  readonly #waiters = new Set<() => void>();
  readonly #fallbacks = new Set<string>();
  readonly #stop: () => void;
  readonly #failureOf: (document: DocumentHop) => XrioError | undefined;

  constructor(browser: DriverBrowser, failureOf: (document: DocumentHop) => XrioError | undefined) {
    this.#failureOf = failureOf;
    this.#stop = browser.onEvent((event) => {
      this.#state = recordDocumentEvent(this.#state, event);

      for (const wake of this.#waiters) {
        wake();
      }
    });
  }

  stop(): void {
    this.#stop();
  }
  get lastRequestUrl(): string | undefined {
    return this.#state.lastRequestUrl;
  }
  get downloaded(): boolean {
    return this.#state.downloadUrl !== undefined;
  }

  loadedDocument(): DocumentHop | undefined {
    if (this.#state.failed) {
      throw browserCrashed();
    }

    const record = currentDocument(this.#state);

    if (record?.loaded !== true) {
      return undefined;
    }

    if (record.response === undefined) {
      throw new XrioError(
        "NETWORK_ERROR",
        "The page committed a document that had no HTTP response.",
        { details: undefined },
      );
    }

    const failure = this.#failureOf(record.response);

    if (failure !== undefined) {
      throw failure;
    }

    return record.response;
  }

  async documentLoaded(deadline: Deadline): Promise<DocumentHop> {
    deadline.throwIfExpired();
    const { promise, resolve, reject } = Promise.withResolvers<DocumentHop>();

    const check = () => {
      try {
        const document = this.loadedDocument();

        if (document !== undefined) {
          resolve(document);

          return;
        }

        if (this.downloaded) {
          reject(this.downloadError());
        }
      } catch (error) {
        reject(error);
      }
    };

    const abort = () => {
      reject(deadline.signal.reason);
    };

    this.#waiters.add(check);
    deadline.signal.addEventListener("abort", abort, { once: true });
    check();

    try {
      return await promise;
    } finally {
      this.#waiters.delete(check);
      deadline.signal.removeEventListener("abort", abort);
    }
  }

  downloadError(): XrioError<"UNSUPPORTED_CONTENT_TYPE"> {
    return unsupportedContentType(downloadResponse(this.#state), [], "");
  }

  isCurrent(document: DocumentHop): boolean {
    return this.#state.current === documentKey(document);
  }

  requestUrls(document: DocumentHop): readonly string[] {
    return requestUrlsOf(this.#state, document);
  }

  responseOf(document: DocumentHop): ResponseDetails {
    const hop = JSON.stringify([document.requestId, document.hopIndex]);

    if (rawHeadersOf(this.#state, document) === undefined && !this.#fallbacks.has(hop)) {
      this.#fallbacks.add(hop);
      publishInternalEvent({
        detail: `Using renderer headers for request ${document.requestId}, hop ${document.hopIndex}; raw headers are unavailable and Set-Cookie may be missing.`,
        event: "raw-header-fallback",
      });
    }

    return documentResponse(this.#state, document);
  }

  reportDropped(): void {
    if (this.#state.droppedUrls > 0) {
      publishInternalEvent({
        detail: `Each document kept at most ${MAX_REQUEST_URLS} URLs; dropped ${this.#state.droppedUrls}.`,
        event: "request-log-dropped",
      });
    }

    if (this.#state.droppedState > 0) {
      publishInternalEvent({
        detail: `Dropped ${this.#state.droppedState} entries of document or response state.`,
        event: "document-state-dropped",
      });
    }
  }
}

const relayFailureOfHost = (relay: RelayFailures, url: string): XrioError | undefined => {
  const hostname = URL.parse(url)?.hostname;

  return hostname === undefined ? undefined : relay?.failureFor(hostname);
};

const relayFailureBehind = (
  relay: RelayFailures,
  failingHop: string | undefined,
  url: URL,
  netError: string,
): XrioError | undefined => {
  if (!PROXY_NET_ERROR.test(netError)) {
    return undefined;
  }

  return relayFailureOfHost(relay, failingHop ?? url.href) ?? relayFailureOfHost(relay, url.href);
};

const relayFailureFor = (relay: RelayFailures, { url }: DocumentHop): XrioError | undefined => {
  const documentUrl = URL.parse(url);

  return documentUrl?.protocol === "http:" ? relay?.failureFor(documentUrl.hostname) : undefined;
};

const navigateTo = async (
  browser: DriverBrowser,
  tracker: PageTracker,
  url: URL,
  relay: RelayFailures,
  deadline: Deadline,
): Promise<void> => {
  try {
    await browser.navigate(url.href, deadline);
  } catch (error) {
    if (isDriverFailure(error, "navigation-failed")) {
      const { netError } = error.reason;

      if (netError === COMMITTED_ERROR_PAGE) {
        return;
      }

      if (tracker.downloaded) {
        throw tracker.downloadError();
      }

      const failingHop = tracker.lastRequestUrl;

      throw (
        relayFailureBehind(relay, failingHop, url, netError) ?? networkFailure(url, netError, error)
      );
    }

    throw isDriverFailure(error, "browser-gone") ? browserCrashed(error) : error;
  }
};

interface CapturedDocument {
  html: string;
  document: DocumentHop;
}

const readSlices = async (
  browser: DriverBrowser,
  { key, length, slices }: Parked,
  deadline: Deadline,
): Promise<string | undefined> => {
  const parts: string[] = [];

  for (let index = 0; index < slices; index += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each slice is read from the one parked string, in order.
    const slice = await browser.evaluateIsolated(
      sliceExpression(key, index, index === slices - 1),
      isSlice,
      deadline,
    );

    if (slice === null) {
      return undefined;
    }

    parts.push(slice);
  }

  const html = parts.join("");

  return html.length === length ? html : undefined;
};

const captureHtml = async (
  browser: DriverBrowser,
  deadline: Deadline,
): Promise<string | undefined> => {
  const reply = await browser.evaluateIsolated(CAPTURE_EXPRESSION, isCaptureReply, deadline);

  if (isHtml(reply)) {
    return reply;
  }

  if (isTooLarge(reply)) {
    throw new XrioError(
      "RESPONSE_TOO_LARGE",
      `The captured document is ${reply.tooLarge} UTF-16 code units, more than ${MAX_CAPTURE_CODE_UNITS}.`,
      { details: undefined },
    );
  }

  return await readSlices(browser, reply, deadline);
};

const requireHtmlDocument = async (
  browser: DriverBrowser,
  tracker: PageTracker,
  document: DocumentHop,
  deadline: Deadline,
): Promise<void> => {
  const details = tracker.responseOf(document);

  if (!isHtmlContentType(details.headers["content-type"])) {
    let preview = "";

    try {
      preview = await browser.responseBody(document.requestId, deadline);
    } catch (error) {
      deadline.throwIfExpired();

      if (isDriverFailure(error, "browser-gone")) {
        throw browserCrashed(error);
      }
    }

    throw unsupportedContentType(details, tracker.requestUrls(document), preview);
  }
};

const captureIfCurrent = async (
  browser: DriverBrowser,
  tracker: PageTracker,
  deadline: Deadline,
): Promise<CapturedDocument | undefined> => {
  const document = await tracker.documentLoaded(deadline);

  try {
    await requireHtmlDocument(browser, tracker, document, deadline);

    const html = await captureHtml(browser, deadline);

    return html !== undefined && tracker.isCurrent(document) ? { document, html } : undefined;
  } catch (error) {
    if (isDriverFailure(error, "document-replaced")) {
      return undefined;
    }

    throw isDriverFailure(error, "browser-gone") ? browserCrashed(error) : error;
  }
};

const captureCurrentDocument = async (
  browser: DriverBrowser,
  tracker: PageTracker,
  deadline: Deadline,
): Promise<CapturedDocument> => {
  const first = await captureIfCurrent(browser, tracker, deadline);

  if (first !== undefined) {
    return first;
  }

  publishInternalEvent({
    detail: "The main-frame document changed during capture; capturing its replacement.",
    event: "document-rebind",
  });

  const rebound = await captureIfCurrent(browser, tracker, deadline);

  if (rebound === undefined) {
    throw new XrioError("NETWORK_ERROR", "The page kept replacing its document during capture.", {
      details: undefined,
    });
  }

  return rebound;
};

const captureHeldDocument = async (
  browser: DriverBrowser,
  tracker: PageTracker,
  waitFor: WaitFor,
  deadline: Deadline,
): Promise<CapturedDocument> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the selector hold must belong to the document captured in this attempt.
    const ready = await waitForSelector(browser, tracker, waitFor, deadline, async () => {
      const captured = await captureCurrentDocument(browser, tracker, deadline);

      return { ...tracker.responseOf(captured.document), html: captured.html };
    });

    // oxlint-disable-next-line eslint/no-await-in-loop -- capture follows the completed selector hold.
    const captured = await captureIfCurrent(browser, tracker, deadline);

    if (captured !== undefined && documentKey(captured.document) === documentKey(ready)) {
      return captured;
    }

    publishInternalEvent({
      detail: "The document changed after its selector hold; waiting on its replacement.",
      event: "document-rebind",
    });
  }

  throw new XrioError(
    "NETWORK_ERROR",
    "The page kept replacing its document after the selector hold.",
    { details: undefined },
  );
};

const GAVE_UP: ReadonlySet<ChallengeOutcome> = new Set([
  "budget_exhausted",
  "deadline",
  "rounds_exhausted",
]);

const challengeGaveUp = (report: ChallengeReport | null): boolean =>
  report !== null && GAVE_UP.has(report.outcome);

const blockInputOf = (tracker: PageTracker, { document, html }: CapturedDocument): BlockInput => ({
  html,
  requestUrls: tracker.requestUrls(document),
  response: tracker.responseOf(document),
});

const settledChallenge = (
  tracker: PageTracker,
  { lastDocument, report }: ChallengeWait,
  captured: CapturedDocument,
): ChallengeReport | null => {
  if (report === null) {
    return null;
  }

  if (challengeCandidate(blockInputOf(tracker, captured)) !== undefined) {
    return report.outcome === "passed" ? { ...report, outcome: "rounds_exhausted" } : report;
  }

  const passedInPlace =
    report.outcome !== "passed" && documentKey(captured.document) === documentKey(lastDocument);

  return { ...report, outcome: passedInPlace ? "passed_in_place" : "passed" };
};

interface Render<Reading> {
  readonly browser: DriverBrowser;
  readonly tracker: PageTracker;
  readonly deadline: Deadline;
  readonly waitFor: WaitFor | undefined;
  readonly readAfterCapture: () => Promise<Reading>;
}

interface Rendered<Reading> {
  readonly afterCapture: Reading;
  readonly captured: CapturedDocument;
  readonly challenge: ChallengeReport | null;
}

type FirstCapture<Reading> =
  | { readonly kind: "rendered"; readonly rendered: Rendered<Reading> }
  | { readonly kind: "late-challenge"; readonly evidence: BlockInput };

const finishCapture = async <Reading>(
  { browser, deadline, readAfterCapture, tracker, waitFor }: Render<Reading>,
  challenge: ChallengeWait,
  captured: CapturedDocument,
): Promise<Rendered<Reading>> => {
  const final =
    waitFor === undefined || challengeGaveUp(settledChallenge(tracker, challenge, captured))
      ? captured
      : await captureHeldDocument(browser, tracker, waitFor, deadline);

  const settled = settledChallenge(tracker, challenge, final);

  tracker.stop();

  return { afterCapture: await readAfterCapture(), captured: final, challenge: settled };
};

const captureUnlessLateChallenge = async <Reading>(
  render: Render<Reading>,
  challenge: ChallengeWait,
): Promise<FirstCapture<Reading>> => {
  const captured = await captureCurrentDocument(render.browser, render.tracker, render.deadline);
  const evidence = blockInputOf(render.tracker, captured);

  if (!challengeGaveUp(challenge.report) && challengeCandidate(evidence) !== undefined) {
    return { evidence, kind: "late-challenge" };
  }

  return { kind: "rendered", rendered: await finishCapture(render, challenge, captured) };
};

const recaptureAfterLateChallenge = async <Reading>(
  render: Render<Reading>,
  challenge: ChallengeWait,
  evidence: BlockInput,
): Promise<Rendered<Reading>> => {
  const { browser, deadline, tracker } = render;

  const late = await timeStage(
    "challenge",
    async () => await waitForChallenge(tracker, deadline, evidence, challenge.report),
    deadline,
  );

  return await timeStage(
    "capture",
    async () =>
      await finishCapture(render, late, await captureCurrentDocument(browser, tracker, deadline)),
    deadline,
  );
};

const sourceOf = (
  relay: RelayFailures,
  tracker: PageTracker,
  { captured, challenge }: Rendered<unknown>,
): Omit<SourceDocument, "identity"> => {
  const relayFailure = relayFailureFor(relay, captured.document);

  if (relayFailure !== undefined) {
    throw relayFailure;
  }

  const input = blockInputOf(tracker, captured);

  return {
    ...input.response,
    block: classifyResponse({ ...input, challenge }),
    html: captured.html,
    requestUrls: input.requestUrls,
    scriptsRan: true,
  };
};

export const renderDocument = async <Reading>(
  browser: DriverBrowser,
  url: URL,
  relay: RelayFailures,
  deadline: Deadline,
  readAfterCapture: () => Promise<Reading>,
  waitFor?: WaitFor,
): Promise<{ source: Omit<SourceDocument, "identity">; afterCapture: Reading }> => {
  const tracker = new PageTracker(browser, (document) => relayFailureFor(relay, document));
  const render: Render<Reading> = { browser, deadline, readAfterCapture, tracker, waitFor };

  try {
    await timeStage(
      "navigation",
      async () => {
        await navigateTo(browser, tracker, url, relay, deadline);
        const document = await tracker.documentLoaded(deadline);
        await requireHtmlDocument(browser, tracker, document, deadline);
      },
      deadline,
    );

    const challenge = await timeStage(
      "challenge",
      async () => await waitForChallenge(tracker, deadline),
      deadline,
    );

    const first = await timeStage(
      "capture",
      async () => await captureUnlessLateChallenge(render, challenge),
      deadline,
    );

    const rendered =
      first.kind === "rendered"
        ? first.rendered
        : await recaptureAfterLateChallenge(render, challenge, first.evidence);

    return { afterCapture: rendered.afterCapture, source: sourceOf(relay, tracker, rendered) };
  } catch (error) {
    throw isDriverFailure(error, "browser-gone") ? browserCrashed(error) : error;
  } finally {
    tracker.reportDropped();
    tracker.stop();
  }
};
