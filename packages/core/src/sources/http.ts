import type { DocumentRequest, SourceDocument } from "../types.ts";

const readHtmlDocument = async (response: Response): Promise<SourceDocument> => {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} while scraping ${response.url}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const [mediaType] = contentType.split(";");

  // ponytail: HTML input only; add plain-text and JSON parsing when needed.
  if (mediaType.trim().toLowerCase() !== "text/html") {
    await response.body?.cancel();
    throw new Error(
      `Expected HTML from ${response.url}; received ${contentType || "no content type"}.`,
    );
  }

  return { html: await response.text(), url: response.url };
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
