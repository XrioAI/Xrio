import type { Protocol } from "devtools-protocol";

import { publishInternalEvent } from "../../../diagnostics.ts";
import type { DocumentHop, DriverEvent, RawHeaders } from "../port.ts";
import type { AnyTargetSession, DomainEvent, TargetSession } from "./protocol.ts";

const NOTHING: readonly DriverEvent[] = [];

const LOGGED_URL = /^https?:/u;

const MAX_DOCUMENT_REQUESTS = 128;

const MAX_REDIRECT_HOPS = 32;

type PageEvent = Exclude<
  DomainEvent,
  {
    readonly method:
      | "Page.downloadProgress"
      | "Page.downloadWillBegin"
      | "Page.javascriptDialogOpening";
  }
>;

interface FrameResource {
  readonly frameId?: string;
  readonly type?: string;
}

const headerPairs = (headers: Protocol.Network.Headers): RawHeaders =>
  Object.entries(headers).map(([name, value]) => [name, value] as const);

export class MainFrameEvents {
  readonly #main: TargetSession<"main">;
  readonly #documentRequests = new Map<string, number>();

  constructor(main: TargetSession<"main">) {
    this.#main = main;
  }

  translate(session: AnyTargetSession, event: PageEvent): readonly DriverEvent[] {
    const onMain = session.id === this.#main.id;

    switch (event.method) {
      case "Network.requestWillBeSent": {
        return this.#request(session, event.params);
      }

      case "Network.responseReceived": {
        const { params } = event;

        return onMain && this.#isMainFrame(params)
          ? [this.#hop(params, params.response, false, params.hasExtraInfo)]
          : NOTHING;
      }

      case "Network.responseReceivedExtraInfo": {
        const { headers, requestId, statusCode } = event.params;

        return onMain && this.#documentRequests.has(requestId)
          ? [
              {
                headers: headerPairs(headers),
                requestId,
                sessionId: session.id,
                status: statusCode,
                type: "raw-headers",
              },
            ]
          : NOTHING;
      }

      case "Page.frameNavigated": {
        const { frame } = event.params;

        return onMain && frame.id === this.#main.targetId && frame.parentId === undefined
          ? [{ frameId: frame.id, loaderId: frame.loaderId, sessionId: session.id, type: "commit" }]
          : NOTHING;
      }

      case "Page.lifecycleEvent": {
        const { frameId, loaderId, name } = event.params;

        return onMain && frameId === this.#main.targetId && name === "DOMContentLoaded"
          ? [{ frameId, loaderId, sessionId: session.id, type: "dom-content-loaded" }]
          : NOTHING;
      }

      default: {
        return NOTHING;
      }
    }
  }

  #hop(
    { requestId, loaderId }: { requestId: string; loaderId: string },
    response: Protocol.Network.Response,
    isRedirect: boolean,
    hasExtraInfo: boolean,
  ): DriverEvent {
    return {
      hop: {
        frameId: this.#main.targetId,
        fromCache:
          response.fromDiskCache === true ||
          response.fromPrefetchCache === true ||
          response.fromServiceWorker === true,
        hasExtraInfo,
        headers: headerPairs(response.headers),
        hopIndex: this.#documentRequests.get(requestId) ?? 0,
        isRedirect,
        loaderId,
        requestId,
        sessionId: this.#main.id,
        status: response.status,
        url: response.url,
      } satisfies DocumentHop,
      type: "document-response",
    };
  }

  #request(
    session: AnyTargetSession,
    params: Protocol.Network.RequestWillBeSentEvent,
  ): readonly DriverEvent[] {
    const request: readonly DriverEvent[] = LOGGED_URL.test(params.request.url)
      ? [
          {
            frameId: params.frameId ?? session.targetId,
            loaderId: params.loaderId,
            sessionId: session.id,
            type: "request",
            url: params.request.url,
          },
        ]
      : NOTHING;

    if (session.id !== this.#main.id || !this.#isMainFrame(params)) {
      return request;
    }

    if (!this.#documentRequests.has(params.requestId)) {
      this.#documentRequests.set(params.requestId, 0);

      if (this.#documentRequests.size > MAX_DOCUMENT_REQUESTS) {
        const oldest = this.#documentRequests.keys().next().value;

        if (oldest !== undefined) {
          this.#documentRequests.delete(oldest);
          publishInternalEvent({
            detail: "Dropped the oldest document request identity at the 128-request limit.",
            event: "document-state-dropped",
          });
        }
      }
    }

    const documentRequest: DriverEvent = {
      frameId: this.#main.targetId,
      loaderId: params.loaderId,
      requestId: params.requestId,
      sessionId: session.id,
      type: "document-request",
      url: params.request.url,
    };

    if (params.redirectResponse === undefined) {
      return [documentRequest, ...request];
    }

    const redirect = this.#hop(params, params.redirectResponse, true, params.redirectHasExtraInfo);
    const next = (this.#documentRequests.get(params.requestId) ?? 0) + 1;
    this.#documentRequests.set(params.requestId, next);

    if (next > MAX_REDIRECT_HOPS) {
      publishInternalEvent({
        detail: "Dropped redirect response metadata beyond the 32-hop limit.",
        event: "document-state-dropped",
      });

      return request;
    }

    return [redirect, documentRequest, ...request];
  }

  #isMainFrame({ frameId, type }: FrameResource): boolean {
    return type === "Document" && frameId === this.#main.targetId;
  }
}
