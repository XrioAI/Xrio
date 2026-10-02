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

`proxy` takes an `http`, `https`, `socks5`, or `socks5h` URL, as a client default or per scrape. It is parsed once, credentials are percent-decoded exactly once, and they never appear in messages. Native `fetch` cannot use a proxy, so until http mode moves to a client that can, a scrape with a proxy rejects with `INVALID_OPTIONS` instead of connecting directly.

`timeoutMs` is one deadline for the whole scrape, covering connecting, redirects, reading the body, and building the result. It defaults to 60,000 and must be a positive integer no greater than 2,147,483,647. When it passes, the scrape rejects with an `XrioError` whose `code` is `TIMEOUT`. To cancel from an SDK or CLI, pass an `AbortController`'s signal:

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

When the caller aborts, the scrape rejects with `signal.reason`, as native APIs do.

HTML responses return normally even for HTTP 403, 404, or 500; callers decide which statuses are acceptable. A returned result has no `error` property. Responses without a `text/html` content type, or with no response body (such as HTTP 204), reject with `code: "UNSUPPORTED_CONTENT_TYPE"`. The error's `details` hold the response's `url`, `status`, `headers`, and `cookies`, plus `body`: at most the first 65,536 bytes of the response body, decoded as UTF-8, so plain-text and JSON block pages stay inspectable. `body` is empty when there is no body. Reading those bytes counts toward `timeoutMs`; reading stops at the limit and the rest of the body is cancelled.

Errors created by this package carry a stable `code` from one closed set, and keep the original error as `cause` when there is one. `INVALID_OPTIONS` is a `TypeError`; every other code is an `XrioError` with typed `details`. `isXrioError(value, code?)` checks the code, so it covers both and narrows `details`:

```ts
import { isXrioError } from "@xrio/core";

try {
  await xrio.scrape({ url: "https://example.com/data.json", format: "html" });
} catch (error) {
  if (isXrioError(error, "UNSUPPORTED_CONTENT_TYPE")) {
    error.details.status;
    error.details.body;
  }
}
```

| Code                       | Error class | When                                                                                                                                                                        |
| -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_OPTIONS`          | `TypeError` | An option is invalid: format, mode, browser path, timeout, proxy, a proxy in http mode (not supported yet), or a URL that is relative, not HTTP(S), or carries credentials. |
| `UNSUPPORTED_CONTENT_TYPE` | `XrioError` | The response is not HTML. `details` holds the response details and a body preview.                                                                                          |
| `TIMEOUT`                  | `XrioError` | The scrape deadline (`timeoutMs`) passed.                                                                                                                                   |
| `MODE_NOT_IMPLEMENTED`     | `XrioError` | Headed or headless mode is not implemented.                                                                                                                                 |

Network failures propagate as native errors. There are no retries. Messages never include URL or proxy credentials.

Migration:

- HTML/Markdown callers now read `result.data`; JSON callers read `result.data.metadata` and `result.data.content`.
- `UNSUPPORTED_CONTENT_TYPE` and `MODE_NOT_IMPLEMENTED` are now `XrioError`s. Response fields moved from the error itself to `error.details`.
- Invalid URLs reject with `INVALID_OPTIONS` instead of `ERR_INVALID_URL`.
- Timeouts reject with `TIMEOUT` instead of a native `TimeoutError`.

The client resolves options, selects a document source by mode, and selects a content operation by format. The source and format mappings are independent. To implement a mode, add its source handler and update the mode mapping; HTTP loading and the scrape workflow do not need to change.

- `options.ts` owns native input validation, defaults, per-call mode resolution, and proxy URL parsing.
- `errors.ts` owns the error codes, `XrioError`, `isXrioError`, and URL redaction for messages.
- `deadline.ts` owns the per-scrape deadline and the one `AbortSignal` every stage observes.
- `sources/` owns document loading and response handling, returning a `SourceDocument`.
- `content/formats.ts` exposes separate HTML, Markdown, and structured-content operations.
- `content/document.ts` owns shared HTML interpretation and URL-resolution rules.

From this package directory, run `vp run build` to generate the ESM entry point and TypeScript declarations in `dist/`. Run `vp run check` and `vp test` from the repository root to validate the workspace.
