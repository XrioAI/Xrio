import { classifyResponse } from "../../blocks/classify.ts";
import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { redactUrl, XrioError } from "../../errors.ts";
import type { ResponseDetails, SourceDocument } from "../../types.ts";
import { responseDetailsFrom } from "../response.ts";
import { DriverError } from "./port.ts";
import type {
  DocumentHop,
  DriverBrowser,
  DriverErrorReason,
  DriverEvent,
  RawHeaders,
} from "./port.ts";

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

interface RawHeaderEvent {
  status: number;
  headers: RawHeaders;
}

const browserCrashed = (cause?: unknown): XrioError =>
  new XrioError("BROWSER_CRASHED", "The browser or its renderer died mid-scrape.", {
    cause,
    details: undefined,
  });

const committedWithoutResponse = (): XrioError =>
  new XrioError("NETWORK_ERROR", "The page committed a document that had no HTTP response.", {
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
  #document: DocumentHop | undefined;
  #committedLoader: string | undefined;
  readonly #responses = new Map<string, DocumentHop>();
  #failure: XrioError | undefined;
  readonly #rawHeaders = new Map<string, RawHeaderEvent[]>();
  readonly #loaded = new Set<string>();
  readonly #waiters = new Set<() => void>();
  readonly #stop: () => void;

  constructor(browser: DriverBrowser) {
    this.#stop = browser.onEvent((event) => {
      this.#record(event);

      for (const wake of this.#waiters) {
        wake();
      }
    });
  }

  stop(): void {
    this.#stop();
  }

  async documentLoaded(deadline: Deadline): Promise<DocumentHop> {
    deadline.throwIfExpired();
    const { promise, resolve, reject } = Promise.withResolvers<DocumentHop>();

    const check = () => {
      if (this.#failure !== undefined) {
        reject(this.#failure);
      } else if (this.#document !== undefined && this.#loaded.has(this.#document.loaderId)) {
        resolve(this.#document);
      } else if (this.#loadedWithoutResponse()) {
        reject(committedWithoutResponse());
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

  #loadedWithoutResponse(): boolean {
    return (
      this.#document === undefined &&
      this.#committedLoader !== undefined &&
      this.#loaded.has(this.#committedLoader)
    );
  }

  isCurrent(document: DocumentHop): boolean {
    return this.#committedLoader === document.loaderId;
  }

  responseOf(document: DocumentHop): ResponseDetails {
    const raw = this.#rawHeaders
      .get(document.requestId)
      ?.findLast(({ status }) => status === document.status);

    if (raw === undefined) {
      publishInternalEvent({
        detail: `No raw headers arrived for request ${document.requestId}; Set-Cookie is unavailable.`,
        event: "raw-header-fallback",
      });
    }

    return responseDetailsFrom(document.url, document.status, raw?.headers ?? document.headers);
  }

  #record(event: DriverEvent): void {
    switch (event.type) {
      case "commit": {
        this.#committedLoader = event.loaderId;
        this.#document = this.#responses.get(event.loaderId);
        break;
      }

      case "dom-content-loaded": {
        this.#loaded.add(event.loaderId);
        break;
      }

      case "document-response": {
        if (!event.hop.isRedirect) {
          this.#responses.set(event.hop.loaderId, event.hop);
        }

        if (!event.hop.isRedirect && event.hop.loaderId === this.#committedLoader) {
          this.#document = event.hop;
        }

        break;
      }

      case "raw-headers": {
        const queued = this.#rawHeaders.get(event.requestId) ?? [];

        queued.push({ headers: event.headers, status: event.status });
        this.#rawHeaders.set(event.requestId, queued);
        break;
      }

      case "request": {
        this.#recordRequest(event.url);
        break;
      }

      case "crash":
      case "disconnect": {
        this.#failure ??= browserCrashed();
        break;
      }

      default: {
        break;
      }
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

const navigationError = (url: URL, failure: DriverError, netError: string): XrioError =>
  new XrioError("NETWORK_ERROR", `Loading ${redactUrl(url)} failed with ${netError}.`, {
    cause: failure,
    details: { netError },
  });

const navigateTo = async (browser: DriverBrowser, url: URL, deadline: Deadline): Promise<void> => {
  try {
    await browser.navigate(url.href, deadline);
  } catch (error) {
    if (isDriverFailure(error, "navigation-failed")) {
      if (error.reason.netError === COMMITTED_ERROR_PAGE) {
        return;
      }

      throw navigationError(url, error, error.reason.netError);
    }

    throw isDriverFailure(error, "browser-gone") ? browserCrashed(error) : error;
  }
};

const reportDropped = (tracker: PageTracker): void => {
  if (tracker.droppedRequestUrls > 0) {
    publishInternalEvent({
      detail: `The request log kept ${MAX_REQUEST_URLS} URLs and dropped ${tracker.droppedRequestUrls}.`,
      event: "request-log-dropped",
    });
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

export const renderDocument = async (
  browser: DriverBrowser,
  url: URL,
  deadline: Deadline,
): Promise<SourceDocument> => {
  const tracker = new PageTracker(browser);

  try {
    await timeStage("navigation", async () => {
      await navigateTo(browser, url, deadline);
      await tracker.documentLoaded(deadline);
    });

    const { document, html } = await timeStage(
      "capture",
      async () => await captureCurrentDocument(browser, tracker, deadline),
    );

    const details = tracker.responseOf(document);

    reportDropped(tracker);

    return {
      ...details,
      block: classifyResponse({
        html,
        requestUrls: tracker.requestUrls,
        response: details,
      }),
      html,
      requestUrls: tracker.requestUrls,
    };
  } finally {
    tracker.stop();
  }
};
