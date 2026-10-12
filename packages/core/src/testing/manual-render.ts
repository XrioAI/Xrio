import { setImmediate as nextTurn } from "node:timers/promises";

import { startDeadline } from "../deadline.ts";
import type {
  DocumentHop,
  DriverBrowser,
  DriverEvent,
  DriverListener,
  PageArea,
  RawHeaders,
  ResultGuard,
} from "../sources/browser/port.ts";
import { renderDocument } from "../sources/browser/render.ts";
import { manualClock } from "./manual-clock.ts";

export const CONTENT = `<html><body><article>${"A useful article with substantial ordinary content. ".repeat(160)}</article></body></html>`;

export const CHALLENGE =
  '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/test"></script></body></html>';

export const LARGE_CHALLENGE = `<html><head><title>Just a moment...</title></head><body><script>${"var padding = 0;".repeat(4000)}</script></body></html>`;

export const PAGE_URL = "https://example.test/";

const HTML_HEADERS: RawHeaders = [["content-type", "text/html"]];

export const challengeHeaders = (vendorHeader: string): RawHeaders => [
  ...HTML_HEADERS,
  [vendorHeader, "challenge"],
];

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

type SelectorState = "matched" | "absent" | "invalid";

interface TurnstileWidget {
  readonly box: PageArea;
  readonly reachable: boolean;
  readonly solved: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly widget: string;
}

export const turnstileWidget = (
  widget: string,
  overrides: Partial<Omit<TurnstileWidget, "widget">> = {},
): TurnstileWidget => ({
  box: { height: 65, width: 300, x: 490, y: 260 },
  reachable: true,
  solved: false,
  viewport: { height: 720, width: 1280 },
  widget,
  ...overrides,
});

const readsWidget = (expression: string): boolean => expression.includes("cf-turnstile-response");

const readsSelector = (expression: string): boolean => expression.includes("querySelectorAll");

const guarded = <Result>(
  value: string | TurnstileWidget | null,
  guard: ResultGuard<Result>,
): Result => {
  if (!guard(value)) {
    throw new Error("Unexpected capture, selector or widget reply.");
  }

  return value;
};

const controlledWidget = () => {
  let shown: TurnstileWidget | null = null;
  let reads = 0;
  let afterClick: (() => void) | undefined;
  const clicks: PageArea[] = [];

  return {
    click: async (area: PageArea): Promise<void> => {
      clicks.push(area);
      await Promise.resolve();
      const run = afterClick;
      afterClick = undefined;
      run?.();
    },
    clicks: () => clicks,
    onClick: (run: () => void) => {
      afterClick = run;
    },
    read: (): TurnstileWidget | null => {
      reads += 1;

      return shown;
    },
    reads: () => reads,
    show: (widget: TurnstileWidget | null) => {
      shown = widget;
    },
  };
};

const bodyOf = (hop: DocumentHop): string => (hop.headers.length > 1 ? CHALLENGE : CONTENT);

const controlledBrowser = (first: DocumentHop) => {
  const listeners = new Set<DriverListener>();
  let html = bodyOf(first);
  let selector: SelectorState = "absent";
  let afterCapture: (() => void) | undefined;
  let captures = 0;
  let navigated = first;
  let navigations = 0;
  const turnstile = controlledWidget();

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
    clickWithin: turnstile.click,
    close: async () => {
      await Promise.resolve();
    },
    evaluateIsolated: async <Result>(
      expression: string,
      guard: ResultGuard<Result>,
    ): Promise<Result> => {
      if (readsWidget(expression)) {
        return guarded(await Promise.resolve(turnstile.read()), guard);
      }

      if (readsSelector(expression)) {
        return guarded(await Promise.resolve(selector), guard);
      }

      const value = guarded(html, guard);

      captures += 1;
      afterCapture?.();
      afterCapture = undefined;
      await Promise.resolve();

      return value;
    },
    navigate: async () => {
      navigations += 1;
      commit(navigated);
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
    seedCookies: async () => await Promise.resolve([]),
  };

  return {
    browser,
    captures: () => captures,
    clicks: turnstile.clicks,
    commit,
    emit,
    listeners: () => listeners.size,
    navigateTo: (hop: DocumentHop) => {
      navigated = hop;
    },
    navigations: () => navigations,
    onCapture: (run: () => void) => {
      afterCapture = run;
    },
    onClick: turnstile.onClick,
    setHtml: (body: string) => {
      html = body;
    },
    setSelector: (value: SelectorState) => {
      selector = value;
    },
    showWidget: turnstile.show,
    widgetReads: turnstile.reads,
  };
};

export const startedRender = (
  first: DocumentHop,
  timeoutMs = 60_000,
  waitFor?: { selector: string },
) => {
  const time = manualClock();
  const deadline = startDeadline(timeoutMs, undefined, time.clock);
  const control = controlledBrowser(first);

  const result = renderDocument(
    control.browser,
    new URL(PAGE_URL),
    undefined,
    deadline,
    async () => await Promise.resolve(null),
    waitFor,
  );

  void Promise.allSettled([result]);

  const tick = async (ms = 250) => {
    time.advance(ms);
    await nextTurn();
  };

  return { ...control, deadline, result, tick, time };
};
