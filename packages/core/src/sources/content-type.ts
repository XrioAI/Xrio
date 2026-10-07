import { classifyResponse } from "../blocks/classify.ts";
import { redactUrl, XrioError } from "../errors.ts";
import type { ResponseDetails } from "../types.ts";

const HTML_MEDIA_TYPES = new Set(["text/html", "application/xhtml+xml"]);

const BODY_PREVIEW_CHARS = 65_536;

export const isHtmlContentType = (contentType: string | undefined): boolean =>
  HTML_MEDIA_TYPES.has((contentType ?? "").split(";")[0].trim().toLowerCase());

const receivedOf = (response: ResponseDetails, body: string | null): string =>
  body === null ? "no response body" : (response.headers["content-type"] ?? "no content type");

export const unsupportedContentType = (
  response: ResponseDetails,
  requestUrls: readonly string[],
  body: string | null,
): XrioError<"UNSUPPORTED_CONTENT_TYPE"> =>
  new XrioError(
    "UNSUPPORTED_CONTENT_TYPE",
    `Expected HTML from ${redactUrl(response.url)}; received ${receivedOf(response, body)}.`,
    {
      details: {
        ...response,
        block: classifyResponse({ html: undefined, requestUrls, response }),
        body: (body ?? "").slice(0, BODY_PREVIEW_CHARS),
      },
    },
  );
