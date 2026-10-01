import type { DocumentRequest, ResponseDetails, SourceDocument } from "../types.ts";

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

const readHtmlDocument = async (response: Response): Promise<SourceDocument> => {
  const details = readResponseDetails(response);
  const contentType = response.headers.get("content-type") ?? "";
  const [mediaType] = contentType.split(";");

  // ponytail: HTML input only; add plain-text and JSON parsing when needed.
  if (mediaType.trim().toLowerCase() !== "text/html" || response.body === null) {
    const received = response.body === null ? "no response body" : contentType || "no content type";

    await response.body?.cancel();
    throw Object.assign(new Error(`Expected HTML from ${response.url}; received ${received}.`), {
      ...details,
      code: "UNSUPPORTED_CONTENT_TYPE",
    });
  }

  return { ...details, html: await response.text() };
};

export const loadHttpDocument = async ({
  url,
  timeoutMs,
  signal,
}: DocumentRequest): Promise<SourceDocument> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, { signal: requestSignal });

  return await readHtmlDocument(response);
};
