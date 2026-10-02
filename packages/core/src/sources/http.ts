import { createSession, RequestError } from "wreq-js";
import type { CreateSessionOptions, Response as ClientResponse, Session } from "wreq-js";

import type { Deadline } from "../deadline.ts";
import { invalidOptions, redactUrl, XrioError } from "../errors.ts";
import { startRelay } from "../proxy/relay.ts";
import type { Relay } from "../proxy/relay.ts";
import type { DocumentRequest, SourceDocument } from "../types.ts";
import { decodeBody } from "./decode.ts";
import { responseDetailsFrom } from "./response.ts";

const chromeProfile = {
  browser: "chrome_149",
  emulation: {
    http2Options: {
      enablePush: false,
      headerTableSize: 65_536,
      headersPseudoOrder: ["Method", "Authority", "Scheme", "Path"],
      headersStreamDependency: { dependencyId: 0, exclusive: true, weight: 255 },
      initialConnectionWindowSize: 15_728_640,
      initialWindowSize: 6_291_456,
      maxHeaderListSize: 262_144,
      settingsOrder: ["HeaderTableSize", "EnablePush", "InitialWindowSize", "MaxHeaderListSize"],
    },
  },
  os: "linux",
} satisfies CreateSessionOptions;

const MAX_BODY_BYTES = 32 * 1024 * 1024;

const UNSUPPORTED_BODY_PREVIEW_BYTES = 65_536;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const FAILURE_AFTER_REQUEST_URI = /for uri \(\S*\): (?<failure>.*)$/su;

const CERTIFICATE_FAILURE = /CERTIFICATE_VERIFY_FAILED/u;

const TUNNEL_FAILURE = /ProxyConnect/u;

const readBody = async (
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  deadline: Deadline,
  url: string,
): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
  deadline.throwIfExpired();

  if (body === null) {
    return { bytes: new Uint8Array(), truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  const cancelOnAbort = () => {
    void Promise.allSettled([reader.cancel()]);
  };

  deadline.signal.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- body chunks arrive in order and are counted as they stream.
      const { done, value } = await reader.read();
      deadline.signal.throwIfAborted();

      if (done) {
        return { bytes: Buffer.concat(chunks), truncated: false };
      }

      const kept = value.subarray(0, maxBytes - length);
      chunks.push(kept);
      length += kept.byteLength;

      if (kept.byteLength < value.byteLength) {
        break;
      }
    }

    await reader.cancel();

    return { bytes: Buffer.concat(chunks), truncated: true };
  } catch (error) {
    deadline.throwIfExpired();
    throw new XrioError("NETWORK_ERROR", `Reading the response from ${redactUrl(url)} failed.`, {
      cause: error,
      details: undefined,
    });
  } finally {
    deadline.signal.removeEventListener("abort", cancelOnAbort);
  }
};

const readDocument = async (
  response: ClientResponse,
  deadline: Deadline,
): Promise<SourceDocument> => {
  const details = responseDetailsFrom(response.url, response.status, response.headers);
  const contentType = details.headers["content-type"] ?? "";
  const [mediaType] = contentType.split(";");
  const body = NULL_BODY_STATUSES.has(response.status) ? null : response.body;

  if (mediaType.trim().toLowerCase() !== "text/html" || body === null) {
    const received = body === null ? "no response body" : contentType || "no content type";
    const preview = await readBody(body, UNSUPPORTED_BODY_PREVIEW_BYTES, deadline, response.url);

    throw new XrioError(
      "UNSUPPORTED_CONTENT_TYPE",
      `Expected HTML from ${redactUrl(response.url)}; received ${received}.`,
      { details: { ...details, body: decodeBody(preview.bytes, contentType) } },
    );
  }

  const { bytes, truncated } = await readBody(body, MAX_BODY_BYTES, deadline, response.url);

  if (truncated) {
    throw new XrioError(
      "RESPONSE_TOO_LARGE",
      `The response from ${redactUrl(response.url)} is larger than ${MAX_BODY_BYTES} bytes.`,
      { details: undefined },
    );
  }

  return { ...details, html: decodeBody(bytes, contentType) };
};

const translateRequestError = (error: RequestError, url: URL, relay: Relay): XrioError => {
  const failure = FAILURE_AFTER_REQUEST_URI.exec(error.message)?.groups?.failure ?? "";

  if (TUNNEL_FAILURE.test(failure)) {
    return (
      relay.failureFor(url.hostname) ??
      new XrioError("NETWORK_ERROR", `Could not open a tunnel to ${url.host}.`, {
        cause: error,
        details: undefined,
      })
    );
  }

  if (CERTIFICATE_FAILURE.test(failure)) {
    return new XrioError(
      "TLS_CERTIFICATE_INVALID",
      `The certificate for ${url.host} was rejected.`,
      {
        cause: error,
        details: undefined,
      },
    );
  }

  return new XrioError("NETWORK_ERROR", `The request to ${redactUrl(url)} failed.`, {
    cause: error,
    details: undefined,
  });
};

const fetchOnce = async (
  session: Session,
  url: URL,
  deadline: Deadline,
  relay: Relay,
): Promise<ClientResponse> => {
  deadline.throwIfExpired();
  let response: ClientResponse;

  try {
    response = await session.fetch(url.href, { signal: deadline.signal });
  } catch (error) {
    throw error instanceof RequestError ? translateRequestError(error, url, relay) : error;
  }

  const relayFailure = url.protocol === "http:" ? relay.failureFor(url.hostname) : undefined;

  if (relayFailure !== undefined) {
    await response.body?.cancel();
    throw relayFailure;
  }

  return response;
};

export const loadHttpDocument = async ({
  url,
  proxy,
  deadline,
}: DocumentRequest): Promise<SourceDocument> => {
  if (proxy !== undefined) {
    throw invalidOptions("proxy is not supported in http mode yet.");
  }

  await using relay = await startRelay(deadline);
  await using session = await createSession({ ...chromeProfile, proxy: relay.url, timeout: 0 });

  return await readDocument(await fetchOnce(session, url, deadline, relay), deadline);
};
