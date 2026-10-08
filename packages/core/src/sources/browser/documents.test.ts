import { describe, expect, it } from "vite-plus/test";

import { documentHop } from "../../testing/manual-render.ts";
import {
  currentDocument,
  documentResponse,
  emptyDocuments,
  recordDocumentEvent,
  requestUrlsOf,
} from "./documents.ts";
import type { DocumentHop, DriverEvent, RawHeaders } from "./port.ts";

const loaded = (document: DocumentHop): DriverEvent[] => [
  { hop: document, type: "document-response" },
  { ...document, type: "commit" },
  { ...document, type: "dom-content-loaded" },
];

const recorded = (events: readonly DriverEvent[]) => {
  let state = emptyDocuments();

  for (const event of events) {
    state = recordDocumentEvent(state, event);
  }

  return state;
};

const extraHeaders = (headers: RawHeaders, status = 200): DriverEvent => ({
  headers,
  requestId: "R1",
  sessionId: "S1",
  status,
  type: "raw-headers",
});

const extra = (cookie: string): DriverEvent => extraHeaders([["Set-Cookie", cookie]]);

describe("document identity", () => {
  it.each([
    { cachedClaimsExtraInfo: false, rawFirst: true },
    { cachedClaimsExtraInfo: false, rawFirst: false },
    { cachedClaimsExtraInfo: true, rawFirst: true },
    { cachedClaimsExtraInfo: true, rawFirst: false },
  ])("matches same-status redirect headers by hop, %j", ({ cachedClaimsExtraInfo, rawFirst }) => {
    const redirect = documentHop({ hasExtraInfo: true, hopIndex: 0, isRedirect: true });
    const final = documentHop({ hasExtraInfo: true, hopIndex: 2 });

    const cached = documentHop({
      fromCache: true,
      hasExtraInfo: cachedClaimsExtraInfo,
      hopIndex: 1,
      isRedirect: true,
    });

    const responses: DriverEvent[] = [redirect, cached, final].map((document) => ({
      hop: document,
      type: "document-response",
    }));

    const raws = [extra("redirect=1"), extra("final=1")];
    const state = recorded(rawFirst ? [...raws, ...responses] : [...responses, ...raws]);
    expect(documentResponse(state, redirect).cookies).toStrictEqual(["redirect=1"]);
    expect(documentResponse(state, cached).cookies).toStrictEqual([]);
    expect(documentResponse(state, final).cookies).toStrictEqual(["final=1"]);
  });

  it("uses renderer headers when raw headers are missing", () => {
    const document = documentHop();
    expect(documentResponse(recorded(loaded(document)), document)).toStrictEqual({
      cookies: [],
      headers: { "content-type": "text/html" },
      status: 200,
      url: "https://example.test/",
    });
  });

  it.each([
    { hasExtraInfo: false, raw: [] },
    { hasExtraInfo: true, raw: [extraHeaders([["x-page", "untyped"]])] },
  ])(
    "leaves an untyped response without a content type, ExtraInfo = $hasExtraInfo",
    ({ hasExtraInfo, raw }) => {
      const document = documentHop({ hasExtraInfo, headers: [] });
      const { headers } = documentResponse(recorded([...loaded(document), ...raw]), document);
      expect(headers).toStrictEqual(hasExtraInfo ? { "x-page": "untyped" } : {});
    },
  );

  it("uses renderer headers for a cached hop that claims ExtraInfo", () => {
    const document = documentHop({
      fromCache: true,
      hasExtraInfo: true,
      headers: [
        ["content-type", "text/html"],
        ["x-from", "renderer"],
      ],
    });

    const state = recorded([...loaded(document), extraHeaders([["set-cookie", "raw=1"]])]);

    expect(documentResponse(state, document)).toStrictEqual({
      cookies: [],
      headers: { "content-type": "text/html", "x-from": "renderer" },
      status: 200,
      url: "https://example.test/",
    });
  });

  it("keeps a replaced document's DOMContentLoaded from loading its replacement", () => {
    const first = documentHop();
    const second = documentHop({ loaderId: "L2", requestId: "R2", status: 403 });

    const state = recorded([
      { hop: first, type: "document-response" },
      { ...first, type: "commit" },
      { hop: second, type: "document-response" },
      { ...second, type: "commit" },
      { ...first, type: "dom-content-loaded" },
    ]);

    expect(currentDocument(state)?.loaded).toBeFalsy();
    expect(currentDocument(state)?.response?.status).toBe(403);
  });

  it("forgets a download once the page commits another document", () => {
    const download: DriverEvent = { type: "download", url: "https://example.test/file.zip" };
    const next = documentHop({ loaderId: "L2", requestId: "R2" });
    const downloading = recorded([...loaded(documentHop()), download]);
    const moved = recorded([...loaded(documentHop()), download, ...loaded(next)]);

    expect([downloading.downloadUrl, moved.downloadUrl]).toStrictEqual([
      "https://example.test/file.zip",
      undefined,
    ]);
  });

  it("separates documents whose loader names match in different sessions", () => {
    const first = documentHop();
    const second = documentHop({ sessionId: "S2", status: 403 });
    const state = recorded([...loaded(first), ...loaded(second)]);
    expect(currentDocument(state)?.response?.status).toBe(403);
    expect(state.records.size).toBe(2);
  });

  it("reports the cached representation's status and content type on a 304 revalidation", () => {
    const document = documentHop({ hasExtraInfo: true });

    const state = recorded([
      ...loaded(document),
      extraHeaders(
        [
          ["etag", "v1"],
          ["set-cookie", "fresh=1"],
        ],
        304,
      ),
    ]);

    expect(documentResponse(state, document)).toStrictEqual({
      cookies: ["fresh=1"],
      headers: { "content-type": "text/html", etag: "v1" },
      status: 200,
      url: "https://example.test/",
    });
  });

  it("caps each document's request log and retains only that document's URLs", () => {
    const first = documentHop();
    let state = recorded(loaded(first));

    for (let index = 0; index < 2010; index += 1) {
      state = recordDocumentEvent(state, {
        ...first,
        type: "request",
        url: `https://example.test/${index}`,
      });
    }

    const second = documentHop({ loaderId: "L2" });

    for (const event of loaded(second)) {
      state = recordDocumentEvent(state, event);
    }

    state = recordDocumentEvent(state, {
      ...second,
      type: "request",
      url: "https://example.test/next",
    });
    state = recordDocumentEvent(state, {
      ...first,
      type: "request",
      url: "https://example.test/late-old",
    });
    expect(requestUrlsOf(state, first)).toHaveLength(2000);
    expect(requestUrlsOf(state, second)).toStrictEqual(["https://example.test/next"]);
    expect(state.droppedUrls).toBe(11);
  });

  it("retains at most four documents' request logs", () => {
    let state = emptyDocuments();

    for (let index = 0; index < 6; index += 1) {
      const document = documentHop({ loaderId: `L${index}`, requestId: `R${index}` });

      for (const event of loaded(document)) {
        state = recordDocumentEvent(state, event);
      }

      for (let request = 0; request <= 2000; request += 1) {
        state = recordDocumentEvent(state, {
          ...document,
          type: "request",
          url: `https://example.test/${request}`,
        });
      }
    }

    let retained = 0;

    for (const record of state.records.values()) {
      retained += record.requestUrls.length;
    }

    expect(retained).toBe(8000);
    expect(requestUrlsOf(state, documentHop({ loaderId: "L5" }))).toHaveLength(2000);
  });

  it("bounds document and response maps and counts evictions", () => {
    let state = emptyDocuments();

    for (let index = 0; index < 160; index += 1) {
      for (const event of loaded(documentHop({ loaderId: `L${index}`, requestId: `R${index}` }))) {
        state = recordDocumentEvent(state, event);
      }
    }

    expect(state.records.size).toBe(4);
    expect(state.responses.size).toBe(128);
    expect(state.droppedState).toBe(188);
    expect(currentDocument(state)?.response?.loaderId).toBe("L159");
  });

  it("attaches loader-less worker scripts to the document that issued them", () => {
    const document = documentHop();

    const state = recorded([
      ...loaded(document),
      { ...document, loaderId: "", type: "request", url: "https://example.test/worker.js" },
      {
        ...document,
        frameId: "worker",
        loaderId: "",
        sessionId: "worker-session",
        type: "request",
        url: "https://example.test/from-worker",
      },
    ]);

    expect(requestUrlsOf(state, document)).toStrictEqual([
      "https://example.test/worker.js",
      "https://example.test/from-worker",
    ]);
  });
});
