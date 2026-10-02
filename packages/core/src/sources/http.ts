import { invalidOptions, redactUrl, XrioError } from "../errors.ts";
import type { DocumentRequest, ResponseDetails, SourceDocument } from "../types.ts";

const UNSUPPORTED_BODY_PREVIEW_BYTES = 65_536;

const readResponseDetails = (response: Response): ResponseDetails => {
  const headers: ResponseDetails["headers"] = {};

  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") {
      headers[name] = value;
    }
  }

  return {
    cookies: response.headers.getSetCookie(),
    headers,
    status: response.status,
    url: response.url,
  };
};

const readBodyPreview = async (body: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (body === null) {
    return "";
  }

  const decoder = new TextDecoder();
  let preview = "";
  let remainingBytes = UNSUPPORTED_BODY_PREVIEW_BYTES;

  for await (const chunk of body) {
    const kept = chunk.subarray(0, remainingBytes);

    preview += decoder.decode(kept, { stream: true });
    remainingBytes -= kept.byteLength;

    if (remainingBytes === 0) {
      break;
    }
  }

  preview += decoder.decode();

  return preview;
};

const readHtmlDocument = async (response: Response): Promise<SourceDocument> => {
  const details = readResponseDetails(response);
  const contentType = response.headers.get("content-type") ?? "";
  const [mediaType] = contentType.split(";");

  // ponytail: HTML input only; add plain-text and JSON parsing when needed.
  if (mediaType.trim().toLowerCase() !== "text/html" || response.body === null) {
    const received = response.body === null ? "no response body" : contentType || "no content type";
    const body = await readBodyPreview(response.body);

    throw new XrioError(
      "UNSUPPORTED_CONTENT_TYPE",
      `Expected HTML from ${redactUrl(response.url)}; received ${received}.`,
      { details: { ...details, body } },
    );
  }

  return { ...details, html: await response.text() };
};

export const loadHttpDocument = async ({
  url,
  proxy,
  deadline,
}: DocumentRequest): Promise<SourceDocument> => {
  if (proxy !== undefined) {
    throw invalidOptions("proxy is not supported in http mode yet.");
  }

  const response = await fetch(url, { signal: deadline.signal });

  return await readHtmlDocument(response);
};
