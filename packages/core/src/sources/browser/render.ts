import { classifyResponse } from "../../blocks/classify.ts";
import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { XrioError } from "../../errors.ts";
import type { Relay } from "../../proxy/relay.ts";
import type { ResponseDetails, SourceDocument } from "../../types.ts";
import { networkFailure } from "../net-error.ts";
import {
  currentDocument,
  documentKey,
  documentResponse,
  emptyDocuments,
  rawHeadersOf,
  recordDocumentEvent,
} from "./documents.ts";
import { DriverError } from "./port.ts";
import type { DocumentHop, DriverBrowser, DriverErrorReason } from "./port.ts";

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

const MAX_REQUEST_URLS = 4000;

const COMMITTED_ERROR_PAGE = "net::ERR_HTTP_RESPONSE_CODE_FAILURE";

const MAX_REQUEST_URL_CHARS = 2048;

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
  readonly requestUrls: string[] = [];
  droppedRequestUrls = 0;
  #state = emptyDocuments();
  readonly #waiters = new Set<() => void>();
  readonly #fallbacks = new Set<string>();
  readonly #stop: () => void;
  readonly #failureOf: (document: DocumentHop) => XrioError | undefined;

  constructor(browser: DriverBrowser, failureOf: (document: DocumentHop) => XrioError | undefined) {
    this.#failureOf = failureOf;
    this.#stop = browser.onEvent((event) => {
      this.#state = recordDocumentEvent(this.#state, event);

      if (event.type === "request") {
        this.#recordRequest(event.url);
      }

      for (const wake of this.#waiters) {
        wake();
      }
    });
  }

  stop(): void {
    this.#stop();
  }

  loadedDocument(): DocumentHop | undefined {
    if (this.#state.failed) {
      throw browserCrashed();
    }

    const record = currentDocument(this.#state);

    const document = record?.loaded === true ? record.response : undefined;
    const failure = document === undefined ? undefined : this.#failureOf(document);

    if (failure !== undefined) {
      throw failure;
    }

    return document;
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

        const record = currentDocument(this.#state);

        if (record?.loaded === true && record.response === undefined) {
          reject(
            new XrioError(
              "NETWORK_ERROR",
              "The page committed a document that had no HTTP response.",
              { details: undefined },
            ),
          );
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

  isCurrent(document: DocumentHop): boolean {
    return this.#state.current === documentKey(document);
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
    if (this.droppedRequestUrls > 0) {
      publishInternalEvent({
        detail: `The request log kept ${MAX_REQUEST_URLS} URLs and dropped ${this.droppedRequestUrls}.`,
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

  #recordRequest(url: string): void {
    if (this.requestUrls.length < MAX_REQUEST_URLS) {
      this.requestUrls.push(url.slice(0, MAX_REQUEST_URL_CHARS));
    } else {
      this.droppedRequestUrls += 1;
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

      const failingHop = tracker.requestUrls.at(-1);

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

const captureIfCurrent = async (
  browser: DriverBrowser,
  tracker: PageTracker,
  deadline: Deadline,
): Promise<CapturedDocument | undefined> => {
  const document = await tracker.documentLoaded(deadline);

  try {
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

export const renderDocument = async <Reading>(
  browser: DriverBrowser,
  url: URL,
  relay: RelayFailures,
  deadline: Deadline,
  readAfterCapture: () => Promise<Reading>,
): Promise<{ source: Omit<SourceDocument, "identity">; afterCapture: Reading }> => {
  const tracker = new PageTracker(browser, (document) => relayFailureFor(relay, document));

  try {
    await timeStage(
      "navigation",
      async () => {
        await navigateTo(browser, tracker, url, relay, deadline);
        await tracker.documentLoaded(deadline);
      },
      deadline,
    );

    const { afterCapture, captured } = await timeStage(
      "capture",
      async () => {
        const current = await captureCurrentDocument(browser, tracker, deadline);

        tracker.stop();

        return { afterCapture: await readAfterCapture(), captured: current };
      },
      deadline,
    );

    const { document, html } = captured;
    const relayFailure = relayFailureFor(relay, document);

    if (relayFailure !== undefined) {
      throw relayFailure;
    }

    const details = tracker.responseOf(document);

    return {
      afterCapture,
      source: {
        ...details,
        block: classifyResponse({
          html,
          requestUrls: tracker.requestUrls,
          response: details,
        }),
        html,
        requestUrls: tracker.requestUrls,
      },
    };
  } finally {
    tracker.reportDropped();
    tracker.stop();
  }
};
