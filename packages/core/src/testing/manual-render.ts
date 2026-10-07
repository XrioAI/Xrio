import { startDeadline } from "../deadline.ts";
import type {
  DocumentHop,
  DriverBrowser,
  DriverEvent,
  DriverListener,
  RawHeaders,
  ResultGuard,
} from "../sources/browser/port.ts";
import { renderDocument } from "../sources/browser/render.ts";
import { manualClock } from "./manual-clock.ts";

export const CONTENT = `<html><body><article>${"A useful article with substantial ordinary content. ".repeat(160)}</article></body></html>`;

export const CHALLENGE =
  '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/test"></script></body></html>';

export const PAGE_URL = "https://example.test/";

const HTML_HEADERS: RawHeaders = [["content-type", "text/html"]];

export const documentHop = (overrides: Partial<DocumentHop> = {}): DocumentHop => ({
  frameId: "F1",
  fromCache: false,
  hasExtraInfo: false,
  headers: HTML_HEADERS,
  hopIndex: 0,
  isRedirect: false,
  loaderId: "L1",
  requestId: "R1",
  sessionId: "S1",
  status: 200,
  url: PAGE_URL,
  ...overrides,
});

const bodyOf = (hop: DocumentHop): string => (hop.headers.length > 1 ? CHALLENGE : CONTENT);

const controlledBrowser = (first: DocumentHop) => {
  const listeners = new Set<DriverListener>();
  let html = bodyOf(first);

  const emit = (event: DriverEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const commit = (hop: DocumentHop, body = bodyOf(hop)) => {
    html = body;
    emit({ hop, type: "document-response" });
    emit({ ...hop, type: "commit" });
    emit({ ...hop, type: "dom-content-loaded" });
  };

  const browser: DriverBrowser = {
    close: async () => {
      await Promise.resolve();
    },
    evaluateIsolated: async <Result>(
      expression: string,
      guard: ResultGuard<Result>,
    ): Promise<Result> => {
      const value: unknown = html;

      if (!guard(value)) {
        throw new Error("Unexpected capture or selector reply.");
      }

      await Promise.resolve();

      return value;
    },
    navigate: async () => {
      commit(first);
      await Promise.resolve();
    },
    onEvent: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    product: { headless: true, major: 154, version: "154.0.0.0" },
    responseBody: async () => await Promise.resolve('{"preview":true}'),
  };

  return {
    browser,
    commit,
    emit,
  };
};

export const startedRender = (first: DocumentHop, timeoutMs = 60_000) => {
  const time = manualClock();
  const deadline = startDeadline(timeoutMs, undefined, time.clock);
  const control = controlledBrowser(first);

  const result = renderDocument(
    control.browser,
    new URL(PAGE_URL),
    undefined,
    deadline,
    async () => await Promise.resolve(null),
  );

  void Promise.allSettled([result]);

  return { ...control, deadline, result, time };
};
