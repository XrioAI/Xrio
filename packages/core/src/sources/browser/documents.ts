import type { ResponseDetails } from "../../types.ts";
import { responseDetailsFrom } from "../response.ts";
import type { DocumentHop, DocumentIdentity, DriverEvent, RawHeaders } from "./port.ts";

const MAX_DOCUMENTS = 4;

const MAX_RESPONSE_REQUESTS = 128;

const MAX_HOPS = 32;

interface DocumentRecord {
  readonly navigation: { requestId: string; url: string } | undefined;
  readonly identity: DocumentIdentity;
  readonly response: DocumentHop | undefined;
  readonly loaded: boolean;
}

interface ExtraHeaders {
  readonly status: number;
  readonly headers: RawHeaders;
}

interface RequestResponses {
  readonly hops: readonly DocumentHop[];
  readonly extras: readonly ExtraHeaders[];
}

export interface Documents {
  readonly current: string | undefined;
  readonly records: ReadonlyMap<string, DocumentRecord>;
  readonly responses: ReadonlyMap<string, RequestResponses>;
  readonly droppedState: number;
  readonly failed: boolean;
}

export const documentKey = ({ sessionId, frameId, loaderId }: DocumentIdentity): string =>
  JSON.stringify([sessionId, frameId, loaderId]);

const requestKey = ({ sessionId, requestId }: { sessionId: string; requestId: string }): string =>
  JSON.stringify([sessionId, requestId]);

export const emptyDocuments = (): Documents => ({
  current: undefined,
  droppedState: 0,
  failed: false,
  records: new Map(),
  responses: new Map(),
});

const emptyRecord = (identity: DocumentIdentity): DocumentRecord => ({
  identity,
  loaded: false,
  navigation: undefined,
  response: undefined,
});

const bounded = <Value>(map: Map<string, Value>, limit: number, protect?: string): number => {
  let dropped = 0;

  for (const key of map.keys()) {
    if (map.size <= limit) {
      break;
    }

    if (key !== protect) {
      map.delete(key);
      dropped += 1;
    }
  }

  return dropped;
};

const recordResponse = (state: Documents, hop: DocumentHop): Documents => {
  const responses = new Map(state.responses);
  const key = requestKey(hop);
  const previous = responses.get(key) ?? { extras: [], hops: [] };

  if (previous.hops.length >= MAX_HOPS) {
    return { ...state, droppedState: state.droppedState + 1 };
  }

  responses.set(key, { ...previous, hops: [...previous.hops, hop] });
  const dropped = bounded(responses, MAX_RESPONSE_REQUESTS);
  const records = new Map(state.records);

  if (!hop.isRedirect) {
    const identity = documentKey(hop);
    records.set(identity, { ...(records.get(identity) ?? emptyRecord(hop)), response: hop });
  }

  return {
    ...state,
    droppedState: state.droppedState + dropped + bounded(records, MAX_DOCUMENTS, state.current),
    records,
    responses,
  };
};

const recordRawHeaders = (
  state: Documents,
  event: Extract<DriverEvent, { type: "raw-headers" }>,
): Documents => {
  const responses = new Map(state.responses);
  const key = requestKey(event);
  const previous = responses.get(key) ?? { extras: [], hops: [] };

  if (previous.extras.length >= MAX_HOPS) {
    return { ...state, droppedState: state.droppedState + 1 };
  }

  responses.set(key, {
    ...previous,
    extras: [...previous.extras, { headers: event.headers, status: event.status }],
  });

  return {
    ...state,
    droppedState: state.droppedState + bounded(responses, MAX_RESPONSE_REQUESTS),
    responses,
  };
};

export const recordDocumentEvent = (state: Documents, event: DriverEvent): Documents => {
  switch (event.type) {
    case "document-request": {
      const key = documentKey(event);
      const records = new Map(state.records);
      const previous = records.get(key) ?? emptyRecord(event);
      records.set(key, { ...previous, navigation: { requestId: event.requestId, url: event.url } });

      return {
        ...state,
        droppedState: state.droppedState + bounded(records, MAX_DOCUMENTS, state.current),
        records,
      };
    }

    case "document-response": {
      return recordResponse(state, event.hop);
    }

    case "raw-headers": {
      return recordRawHeaders(state, event);
    }

    case "request": {
      return state;
    }

    case "commit":
    case "dom-content-loaded": {
      const key = documentKey(event);
      const records = new Map(state.records);
      const previous = records.get(key) ?? emptyRecord(event);
      records.set(key, {
        ...previous,
        loaded: previous.loaded || event.type === "dom-content-loaded",
      });
      const current = event.type === "commit" ? key : state.current;

      return {
        ...state,
        current,
        droppedState: state.droppedState + bounded(records, MAX_DOCUMENTS, current),
        records,
      };
    }

    case "crash":
    case "disconnect": {
      return { ...state, failed: true };
    }

    default: {
      const exhaustive: never = event;

      return exhaustive;
    }
  }
};

export const currentDocument = (state: Documents): DocumentRecord | undefined =>
  state.current === undefined ? undefined : state.records.get(state.current);

const receivesRawHeaders = ({ fromCache, hasExtraInfo }: DocumentHop): boolean =>
  hasExtraInfo && !fromCache;

export const rawHeadersOf = (state: Documents, hop: DocumentHop): ExtraHeaders | undefined => {
  if (!receivesRawHeaders(hop)) {
    return undefined;
  }

  const responses = state.responses.get(requestKey(hop));

  const index = responses?.hops.filter(
    (entry) => receivesRawHeaders(entry) && entry.hopIndex < hop.hopIndex,
  ).length;

  return index === undefined ? undefined : responses?.extras[index];
};

export const documentResponse = (state: Documents, hop: DocumentHop): ResponseDetails => {
  const raw = rawHeadersOf(state, hop);
  const effective = responseDetailsFrom(hop.url, hop.status, hop.headers);

  if (raw === undefined) {
    return effective;
  }

  const details = responseDetailsFrom(hop.url, hop.status, raw.headers);

  return { ...details, headers: { ...effective.headers, ...details.headers } };
};
