import type { Protocol } from "devtools-protocol";

import type { DocumentHop, DriverEvent, RawHeaders } from "../port.ts";
import type { AnyTargetSession, DomainEvent, TargetSession } from "./protocol.ts";

const NOTHING: readonly DriverEvent[] = [];

type PageEvent = Exclude<
  DomainEvent,
  {
    readonly method:
      | "Page.downloadProgress"
      | "Page.downloadWillBegin"
      | "Page.javascriptDialogOpening";
  }
>;

const LOGGED_URL = /^https?:/u;

interface FrameResource {
  readonly frameId?: string;
  readonly type?: string;
}

const headerPairs = (headers: Protocol.Network.Headers): RawHeaders =>
  Object.entries(headers).map(([name, value]) => [name, value] as const);

const hopOf = (
  { requestId, loaderId }: { readonly requestId: string; readonly loaderId: string },
  response: Protocol.Network.Response,
  isRedirect: boolean,
): DriverEvent => ({
  hop: {
    headers: headerPairs(response.headers),
    isRedirect,
    loaderId,
    requestId,
    status: response.status,
    url: response.url,
  } satisfies DocumentHop,
  type: "document-response",
});

const requested = (url: string): readonly DriverEvent[] =>
  LOGGED_URL.test(url) ? [{ type: "request", url }] : NOTHING;

const rawHeadersOf = ({
  headers,
  requestId,
  statusCode,
}: Protocol.Network.ResponseReceivedExtraInfoEvent): DriverEvent => ({
  headers: headerPairs(headers),
  requestId,
  status: statusCode,
  type: "raw-headers",
});

export class MainFrameEvents {
  readonly #main: TargetSession<"main">;
  readonly #documentRequests = new Set<string>();

  constructor(main: TargetSession<"main">) {
    this.#main = main;
  }

  translate(session: AnyTargetSession, event: PageEvent): readonly DriverEvent[] {
    const onMain = session.id === this.#main.id;

    switch (event.method) {
      case "Network.requestWillBeSent": {
        return this.#request(onMain, event.params);
      }

      case "Network.responseReceived": {
        return onMain && this.#isMainFrame(event.params)
          ? [hopOf(event.params, event.params.response, false)]
          : NOTHING;
      }

      case "Network.responseReceivedExtraInfo": {
        return onMain && this.#documentRequests.has(event.params.requestId)
          ? [rawHeadersOf(event.params)]
          : NOTHING;
      }

      case "Page.frameNavigated": {
        return onMain ? this.#commit(event.params.frame) : NOTHING;
      }

      case "Page.lifecycleEvent": {
        return onMain ? this.#domContentLoaded(event.params) : NOTHING;
      }

      default: {
        return NOTHING;
      }
    }
  }

  #request(
    onMain: boolean,
    params: Protocol.Network.RequestWillBeSentEvent,
  ): readonly DriverEvent[] {
    const request = requested(params.request.url);

    if (!onMain || !this.#isMainFrame(params)) {
      return request;
    }

    this.#documentRequests.add(params.requestId);

    return params.redirectResponse === undefined
      ? request
      : [hopOf(params, params.redirectResponse, true), ...request];
  }

  #commit(frame: Protocol.Page.Frame): readonly DriverEvent[] {
    return frame.id === this.#main.targetId && frame.parentId === undefined
      ? [{ frameId: frame.id, loaderId: frame.loaderId, type: "commit" }]
      : NOTHING;
  }

  #domContentLoaded({
    frameId,
    loaderId,
    name,
  }: Protocol.Page.LifecycleEventEvent): readonly DriverEvent[] {
    return frameId === this.#main.targetId && name === "DOMContentLoaded"
      ? [{ frameId, loaderId, type: "dom-content-loaded" }]
      : NOTHING;
  }

  #isMainFrame({ frameId, type }: FrameResource): boolean {
    return type === "Document" && frameId === this.#main.targetId;
  }
}
