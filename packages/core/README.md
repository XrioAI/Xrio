# @xrio/core

Fetch an HTML page and return its HTML, Markdown, or structured content. Requires Node.js 24 or newer.

```ts
import { XrioClient } from "@xrio/core";

const xrio = new XrioClient();

const result = await xrio.scrape({
  url: "https://example.com",
  format: "json",
  timeoutMs: 60_000,
});

result.data.metadata.title;
result.data.content.markdown;
result.status;
result.headers["content-type"];
result.cookies;
result.url;
```

`format` is required. Every call returns a `ScrapeResult` with `{ data, url, status, headers, cookies, format }`:

- `data`: an HTML or Markdown string, or `StructuredContent` for `json`.
- `url`: the final response URL after redirects.
- `status`: the actual HTTP response status, including non-2xx statuses.
- `headers`: a plain object with lowercase names and string values, typed `string | undefined` because a header the response did not send is absent. `set-cookie` is never included; use `cookies`.
- `cookies`: each `Set-Cookie` header value of the final response, in order and unparsed. Empty when the response set none.
- `format`: the requested format. Checking this field narrows the type of `data` in TypeScript.

For `json`, `data` retains the existing `StructuredContent` fields:

- `metadata`: final response `url`, `title`, `description`, and `language`. Missing descriptive metadata is `null`.
- `content`: `markdown`, plain `text`, `links: { text, href }[]`, and `images: { alt, src }[]`.

HTML preserves the decoded response body. Markdown and text cover the whole body, including navigation, sidebars, footers, and `noscript` content. JSON uses the same Markdown conversion as `format: "markdown"`. Links and images retain duplicates and source order, including elements inside templates. Their URLs resolve against the final response URL and the first `<base href>` when present. Conversion uses `@mdream/js`.

The default mode is `http`, which uses native `fetch`. Configure a client default with `new XrioClient({ mode: "http" })` or override it on an individual scrape. Overrides never change the client. Browser modes (`headless` and `headed`) require `browserPath` and currently reject with a not-implemented error. An explicit browser-mode override must supply its own path.

`timeoutMs` applies to fetching and reading the response body, defaults to 60,000, and must be a positive integer no greater than 2,147,483,647. To cancel from an SDK or CLI, pass an `AbortController`'s signal:

```ts
const controller = new AbortController();
const pending = xrio.scrape({
  url: "https://example.com",
  format: "markdown",
  signal: controller.signal,
});

// Call controller.abort() from the caller's cancellation handler.
const result = await pending;
result.data;
```

HTML responses return normally even for HTTP 403, 404, or 500; callers decide which statuses are acceptable. A returned result has no `error` property. Responses without a `text/html` content type, or with no response body (such as HTTP 204), throw an `Error` with `code: "UNSUPPORTED_CONTENT_TYPE"` and the response's `url`, `status`, `headers`, and `cookies`.

Errors created by this package have stable codes:

| Code                       | Error class | Meaning                                                       |
| -------------------------- | ----------- | ------------------------------------------------------------- |
| `INVALID_OPTIONS`          | `TypeError` | Invalid format, mode, browser path, timeout, or URL protocol. |
| `UNSUPPORTED_CONTENT_TYPE` | `Error`     | The response cannot be processed as an HTML document.         |
| `MODE_NOT_IMPLEMENTED`     | `Error`     | Headed or headless mode is not implemented.                   |

Native errors propagate unchanged, including URL parsing (`ERR_INVALID_URL`), network, timeout, and cancellation failures. There is no blanket catch or error wrapping, and there are no retries. Consumers can inspect `error.code` on package errors after narrowing the caught value; native errors retain their own identifiers and causes.

Migration: HTML/Markdown callers now read `result.data`; JSON callers read `result.data.metadata` and `result.data.content`.

The client resolves options, selects a document source by mode, and selects a content operation by format. The source and format mappings are independent. To implement a mode, add its source handler and update the mode mapping; HTTP loading and the scrape workflow do not need to change.

- `options.ts` owns native input validation, defaults, and per-call mode resolution.
- `sources/` owns document loading and response handling, returning a `SourceDocument`.
- `content/formats.ts` exposes separate HTML, Markdown, and structured-content operations.
- `content/document.ts` owns shared HTML interpretation and URL-resolution rules.

From this package directory, run `vp run build` to generate the ESM entry point and TypeScript declarations in `dist/`. Run `vp run check` and `vp test` from the repository root to validate the workspace.
