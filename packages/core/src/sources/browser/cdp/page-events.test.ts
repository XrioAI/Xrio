import type { Protocol } from "devtools-protocol";
import { describe, expect, it } from "vite-plus/test";

import { MainFrameEvents } from "./page-events.ts";
import type { AnyTargetSession, TargetSession } from "./protocol.ts";

type PageEvent = Parameters<MainFrameEvents["translate"]>[1];

const MAIN: TargetSession<"main"> = { id: "S1", scope: "main", targetId: "T1" };

const IFRAME: TargetSession<"iframe"> = { id: "S2", scope: "iframe", targetId: "F2" };

const WORKER: TargetSession<"worker"> = { id: "S3", scope: "worker", targetId: "W3" };

const ORIGIN = "https://example.test";

interface RequestFields {
  readonly url: string;
  readonly requestId?: string;
  readonly frameId?: string;
  readonly type?: Protocol.Network.ResourceType;
  readonly redirectResponse?: Protocol.Network.Response;
}

const response = (
  url: string,
  status: number,
  headers: Protocol.Network.Headers,
): Protocol.Network.Response => ({
  charset: "",
  connectionId: 0,
  connectionReused: false,
  encodedDataLength: 0,
  headers,
  mimeType: "text/html",
  securityState: "neutral",
  status,
  statusText: "",
  url,
});

const requestSent = ({
  url,
  requestId = "L1",
  frameId = "T1",
  type = "Document",
  redirectResponse,
}: RequestFields): PageEvent => ({
  method: "Network.requestWillBeSent",
  params: {
    documentURL: url,
    frameId,
    initiator: { type: "other" },
    loaderId: "L1",
    redirectHasExtraInfo: true,
    redirectResponse,
    request: {
      headers: {},
      initialPriority: "VeryHigh",
      method: "GET",
      referrerPolicy: "strict-origin-when-cross-origin",
      url,
    },
    requestId,
    timestamp: 0,
    type,
    wallTime: 0,
  },
});

const responseReceived = (
  url: string,
  status: number,
  { requestId = "L1", frameId = "T1" } = {},
): PageEvent => ({
  method: "Network.responseReceived",
  params: {
    frameId,
    hasExtraInfo: true,
    loaderId: "L1",
    requestId,
    response: response(url, status, { "content-type": "text/html" }),
    timestamp: 0,
    type: "Document",
  },
});

const rawHeaders = (
  statusCode: number,
  headers: Protocol.Network.Headers,
  requestId = "L1",
): PageEvent => ({
  method: "Network.responseReceivedExtraInfo",
  params: {
    blockedCookies: [],
    headers,
    requestId,
    resourceIPAddressSpace: "Loopback",
    statusCode,
  },
});

const navigated = (id: string, parentId?: string): PageEvent => ({
  method: "Page.frameNavigated",
  params: {
    frame: {
      crossOriginIsolatedContextType: "NotIsolated",
      domainAndRegistry: "example.test",
      gatedAPIFeatures: [],
      id,
      loaderId: "L1",
      mimeType: "text/html",
      parentId,
      secureContextType: "Secure",
      securityOrigin: ORIGIN,
      url: `${ORIGIN}/landing`,
    },
    type: "Navigation",
  },
});

const lifecycle = (frameId: string, name: string): PageEvent => ({
  method: "Page.lifecycleEvent",
  params: { frameId, loaderId: "L1", name, timestamp: 0 },
});

const translateAll = (events: readonly (readonly [AnyTargetSession, PageEvent])[]) => {
  const frame = new MainFrameEvents(MAIN);

  return events.flatMap(([session, event]) => frame.translate(session, event));
};

describe(MainFrameEvents, () => {
  it("binds every hop of a redirect chain, each with the cookies its response set", () => {
    const first = response(`${ORIGIN}/redirect/1`, 302, { location: "/redirect/2" });
    const second = response(`${ORIGIN}/redirect/2`, 302, { location: "/landing" });

    expect(
      translateAll([
        [MAIN, requestSent({ url: `${ORIGIN}/redirect/1` })],
        [MAIN, rawHeaders(302, { Location: "/redirect/2", "Set-Cookie": "hop1=1; Path=/" })],
        [MAIN, requestSent({ redirectResponse: first, url: `${ORIGIN}/redirect/2` })],
        [MAIN, rawHeaders(302, { Location: "/landing", "Set-Cookie": "hop2=1; Path=/" })],
        [MAIN, requestSent({ redirectResponse: second, url: `${ORIGIN}/landing` })],
        [MAIN, responseReceived(`${ORIGIN}/landing`, 200)],
        [MAIN, rawHeaders(200, { "Set-Cookie": "landing=1; Path=/" })],
        [MAIN, navigated("T1")],
        [MAIN, lifecycle("T1", "DOMContentLoaded")],
      ]),
    ).toStrictEqual([
      {
        frameId: "T1",
        loaderId: "L1",
        requestId: "L1",
        sessionId: "S1",
        type: "document-request",
        url: `${ORIGIN}/redirect/1`,
      },
      {
        frameId: "T1",
        loaderId: "L1",
        sessionId: "S1",
        type: "request",
        url: `${ORIGIN}/redirect/1`,
      },
      {
        headers: [
          ["Location", "/redirect/2"],
          ["Set-Cookie", "hop1=1; Path=/"],
        ],
        requestId: "L1",
        sessionId: "S1",
        status: 302,
        type: "raw-headers",
      },
      {
        hop: {
          frameId: "T1",
          fromCache: false,
          hasExtraInfo: true,
          headers: [["location", "/redirect/2"]],
          hopIndex: 0,
          isRedirect: true,
          loaderId: "L1",
          requestId: "L1",
          sessionId: "S1",
          status: 302,
          url: `${ORIGIN}/redirect/1`,
        },
        type: "document-response",
      },
      {
        frameId: "T1",
        loaderId: "L1",
        requestId: "L1",
        sessionId: "S1",
        type: "document-request",
        url: `${ORIGIN}/redirect/2`,
      },
      {
        frameId: "T1",
        loaderId: "L1",
        sessionId: "S1",
        type: "request",
        url: `${ORIGIN}/redirect/2`,
      },
      {
        headers: [
          ["Location", "/landing"],
          ["Set-Cookie", "hop2=1; Path=/"],
        ],
        requestId: "L1",
        sessionId: "S1",
        status: 302,
        type: "raw-headers",
      },
      {
        hop: {
          frameId: "T1",
          fromCache: false,
          hasExtraInfo: true,
          headers: [["location", "/landing"]],
          hopIndex: 1,
          isRedirect: true,
          loaderId: "L1",
          requestId: "L1",
          sessionId: "S1",
          status: 302,
          url: `${ORIGIN}/redirect/2`,
        },
        type: "document-response",
      },
      {
        frameId: "T1",
        loaderId: "L1",
        requestId: "L1",
        sessionId: "S1",
        type: "document-request",
        url: `${ORIGIN}/landing`,
      },
      { frameId: "T1", loaderId: "L1", sessionId: "S1", type: "request", url: `${ORIGIN}/landing` },
      {
        hop: {
          frameId: "T1",
          fromCache: false,
          hasExtraInfo: true,
          headers: [["content-type", "text/html"]],
          hopIndex: 2,
          isRedirect: false,
          loaderId: "L1",
          requestId: "L1",
          sessionId: "S1",
          status: 200,
          url: `${ORIGIN}/landing`,
        },
        type: "document-response",
      },
      {
        headers: [["Set-Cookie", "landing=1; Path=/"]],
        requestId: "L1",
        sessionId: "S1",
        status: 200,
        type: "raw-headers",
      },
      { frameId: "T1", loaderId: "L1", sessionId: "S1", type: "commit" },
      { frameId: "T1", loaderId: "L1", sessionId: "S1", type: "dom-content-loaded" },
    ]);
  });

  it.each([
    {
      order: "before",
      sequence: [rawHeaders(200, { "Set-Cookie": "a=1" }), responseReceived(`${ORIGIN}/`, 200)],
      types: ["raw-headers", "document-response"],
    },
    {
      order: "after",
      sequence: [responseReceived(`${ORIGIN}/`, 200), rawHeaders(200, { "Set-Cookie": "a=1" })],
      types: ["document-response", "raw-headers"],
    },
  ])("forwards raw headers that arrive $order the response", ({ sequence, types }) => {
    const events = translateAll([
      [MAIN, requestSent({ url: `${ORIGIN}/` })],
      ...sequence.map((event) => [MAIN, event] as const),
    ]);

    expect(events.map(({ type }) => type)).toStrictEqual(["document-request", "request", ...types]);
    expect(events.find(({ type }) => type === "raw-headers")).toStrictEqual({
      headers: [["Set-Cookie", "a=1"]],
      requestId: "L1",
      sessionId: "S1",
      status: 200,
      type: "raw-headers",
    });
  });

  it("logs iframe and worker requests from every session, but binds no document there", () => {
    expect(
      translateAll([
        [MAIN, requestSent({ frameId: "F2", requestId: "R2", url: "https://cross.test/framed" })],
        [
          MAIN,
          responseReceived("https://cross.test/framed", 200, { frameId: "F2", requestId: "R2" }),
        ],
        [MAIN, rawHeaders(200, { "Set-Cookie": "framed=1" }, "R2")],
        [
          IFRAME,
          requestSent({
            frameId: "F2",
            requestId: "R3",
            type: "Image",
            url: "https://cross.test/pixel",
          }),
        ],
        [
          IFRAME,
          responseReceived("https://cross.test/pixel", 200, { frameId: "T1", requestId: "L1" }),
        ],
        [IFRAME, navigated("F2")],
        [IFRAME, lifecycle("F2", "DOMContentLoaded")],
        [
          WORKER,
          requestSent({
            frameId: "W3",
            requestId: "R4",
            type: "Fetch",
            url: `${ORIGIN}/from-worker`,
          }),
        ],
      ]),
    ).toStrictEqual([
      {
        frameId: "F2",
        loaderId: "L1",
        sessionId: "S1",
        type: "request",
        url: "https://cross.test/framed",
      },
      {
        frameId: "F2",
        loaderId: "L1",
        sessionId: "S2",
        type: "request",
        url: "https://cross.test/pixel",
      },
      {
        frameId: "W3",
        loaderId: "L1",
        sessionId: "S3",
        type: "request",
        url: `${ORIGIN}/from-worker`,
      },
    ]);
  });

  it("ignores subframe commits and every lifecycle event but the main frame's DOMContentLoaded", () => {
    expect(
      translateAll([
        [MAIN, navigated("F9", "T1")],
        [MAIN, lifecycle("F9", "DOMContentLoaded")],
        [MAIN, lifecycle("T1", "init")],
        [MAIN, lifecycle("T1", "load")],
        [MAIN, lifecycle("T1", "DOMContentLoaded")],
      ]),
    ).toStrictEqual([
      { frameId: "T1", loaderId: "L1", sessionId: "S1", type: "dom-content-loaded" },
    ]);
  });

  it("keeps only http and https requests in the request log", () => {
    expect(
      translateAll(
        [
          "data:image/png;base64,iVBORw0KGgo=",
          "blob:https://example.test/0b5c",
          "chrome-extension://abc/script.js",
          "http://example.test/plain",
          "https://example.test/secure",
        ].map((url) => [MAIN, requestSent({ requestId: url, type: "Image", url })] as const),
      ),
    ).toStrictEqual([
      {
        frameId: "T1",
        loaderId: "L1",
        sessionId: "S1",
        type: "request",
        url: "http://example.test/plain",
      },
      {
        frameId: "T1",
        loaderId: "L1",
        sessionId: "S1",
        type: "request",
        url: "https://example.test/secure",
      },
    ]);
  });
});
