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

`format` is required. Every call returns a `ScrapeResult` with `{ data, url, status, headers, cookies, format, block }`:

- `data`: an HTML or Markdown string, or `StructuredContent` for `json`.
- `url`: the final response URL after redirects.
- `status`: the actual HTTP response status, including non-2xx statuses.
- `headers`: a plain object with lowercase names and string values, typed `string | undefined` because a header the response did not send is absent. `set-cookie` is never included; use `cookies`.
- `cookies`: each `Set-Cookie` header value of the final response, in order and unparsed. Empty when the response set none.
- `format`: the requested format. Checking this field narrows the type of `data` in TypeScript.
- `block`: the block report described below. Detection never throws, and a challenge served as a 200 still reports a block.

For `json`, `data` retains the existing `StructuredContent` fields:

- `metadata`: final response `url`, `title`, `description`, and `language`. Missing descriptive metadata is `null`.
- `content`: `markdown`, plain `text`, `links: { text, href }[]`, and `images: { alt, src }[]`.

HTML preserves the decoded response body. Bodies are decoded with WHATWG rules: a byte-order mark first, then the `Content-Type` charset, then a `<meta>` charset in the first 1,024 bytes, then UTF-8. Unknown labels fall back to UTF-8, and `iso-8859-1` decodes as windows-1252, as browsers do. Markdown and text cover the whole body, including navigation, sidebars, footers, and `noscript` content. JSON uses the same Markdown conversion as `format: "markdown"`. Links and images retain duplicates and source order, including elements inside templates. Their URLs resolve against the final response URL and the first `<base href>` when present. Conversion uses `@mdream/js`.

The default mode is `http`. Over HTTPS it sends the request a Chrome navigation would send: the TLS ClientHello, HTTP/2 SETTINGS, WINDOW_UPDATE and priority frames, and the header set and order come from a pinned Chrome profile in [`wreq-js`](https://github.com/sqdshguy/wreq-js), on Linux. The profile is Chrome 149, the newest the binding offers; Chrome 150 and later add ML-DSA signature algorithms, signature-algorithm GREASE and a trust-anchors extension that it cannot send yet, so the profile claims Chrome 149 throughout rather than mixing versions. A scheduled check (`scripts/check-http-identity.ts`) compares the HTTP/2 wire identity with a recorded Chrome 154 capture and flags the profile when it falls behind Chrome stable. HTTP/1.1 requests use Chrome's header order and name case and keep the connection alive, but they are not compared with a Chrome capture, and plain `http://` requests still carry the `sec-ch-ua`, `sec-fetch-*` and `br, zstd` values Chrome sends only to secure origins. Redirects are followed for up to 20 hops, cookies set on one hop are sent on the next, and `url` is the final URL. A body over 32 MiB after decompression (counted before charset decoding) rejects with `RESPONSE_TOO_LARGE`.

`proxy` takes an `http`, `https`, `socks5`, or `socks5h` URL, as a client default or per scrape. Credentials are percent-decoded once and never appear in messages. Both SOCKS schemes resolve names at the proxy, so target names never reach the local resolver. Requests go through a local relay that dials the proxy, so a 407, an unreachable proxy, and a refused tunnel report distinct codes. Without a proxy, the relay connects directly. The ambient `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` variables are ignored. Loopback and link-local targets are never sent through a proxy.

Configure a client default with `new XrioClient({ mode: "http" })` or override it on an individual scrape. Overrides never change the client. Browser modes (`headless` and `headed`) require `browserPath` and currently reject with a not-implemented error. An explicit browser-mode override must supply its own path.

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

HTML responses return normally even for HTTP 403, 404, or 500; callers decide which statuses are acceptable. A returned result has no `error` property. Responses without a `text/html` content type, or with no response body (such as HTTP 204), reject with `code: "UNSUPPORTED_CONTENT_TYPE"`. The error's `details` hold the response's `url`, `status`, `headers`, and `cookies`, plus `body`: at most the first 65,536 bytes of the response body, decoded with the same charset rules as HTML, so plain-text and JSON block pages stay inspectable. `body` is empty when there is no body. Reading those bytes counts toward `timeoutMs`; reading stops at the limit and the rest of the body is cancelled.

### Block report

`block` is `{ verdict, vendor, evidence, passedChallenges, challenge }`. The rules are data (`blocks/rules.ts`), and no vendor is named in code.

- `verdict`: `ok`, `suspect`, `blocked`, `queued` (a Queue-it waiting room, which is not a block and should not be retried harder), or `unknown` (classification itself failed).
- `vendor`: the vendor whose evidence decided the verdict, or `null`.
- `evidence`: every rule that fired, ordered by tier, each `{ rule, tier, family, vendor, detail }`. `detail` is at most 160 characters. It never includes cookie values, query-string values (only the names of parameters that have one), or the value of a header that matters only by its presence.
- `passedChallenges`: rules that prove a challenge was issued but did not decide, because the captured document is not shaped like an interstitial. The challenge was passed, or the page was served around it.
- `challenge`: `null` for now. Browser modes will report their challenge wait here, with its `outcome` and one entry per round.

Evidence has tiers. E0 decides alone. E1 decides alone. Its markup rules fire only on a document small enough to be an interstitial (at most 50,000 characters of HTML and 5,000 of text, counted as code points with entities decoded), and the vendor sensors that also load on working pages need fewer than 100 text characters as well; an E1 challenge cookie needs only an HTML response. Every pass over the markup, the request URLs and the cookies runs in time linear in its input, and markup rules that apply at any size read only the first 1 MiB of the document, so a hostile page cannot stall classification. E2 is weak, and decides `blocked` only when two signals come from different families; one family is `suspect`. Status codes are E2 at most, so a 403 alone is never `blocked`. E3 suppressors cancel E1 and E2 for non-HTML, JSON and XML bodies. These page-shape thresholds come from [crawl4ai](https://github.com/unclecode/crawl4ai) (Apache-2.0).

Responses that are not HTML are classified without a body, and the report rides on the `UNSUPPORTED_CONTENT_TYPE` error's `details.block`. Only E0 evidence that needs no body, such as a challenge header or a waiting-room URL, can decide them; status and request-log evidence is listed but does not decide, and the challenge cookie, which needs an HTML response, is not checked.

In http mode the classifier sees only the redirect chain as request URLs, so two limits apply:

- a single-page-app shell (a small document with little text and a lot of script) can read as `suspect`;
- a challenge issued by a page's scripts, or seen only in its subresource requests, is invisible without a browser.

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

| Code                       | Error class | When                                                                                                                              |
| -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_OPTIONS`          | `TypeError` | An option is invalid: format, mode, browser path, timeout, proxy, or a URL that is relative, not HTTP(S), or carries credentials. |
| `UNSUPPORTED_CONTENT_TYPE` | `XrioError` | The response is not HTML. `details` holds the response details, a body preview, and the block report.                             |
| `TIMEOUT`                  | `XrioError` | The scrape deadline (`timeoutMs`) passed.                                                                                         |
| `NETWORK_ERROR`            | `XrioError` | DNS failure, refused or reset connection, protocol error, or a proxy that could not reach the target (502–504).                   |
| `TLS_CERTIFICATE_INVALID`  | `XrioError` | The certificate was rejected.                                                                                                     |
| `TOO_MANY_REDIRECTS`       | `XrioError` | More than 20 redirects.                                                                                                           |
| `RESPONSE_TOO_LARGE`       | `XrioError` | The decompressed body is over 32 MiB.                                                                                             |
| `PROXY_AUTH_FAILED`        | `XrioError` | The proxy answered 407, or a SOCKS5 proxy rejected the credentials.                                                               |
| `PROXY_UNREACHABLE`        | `XrioError` | Xrio could not connect to the proxy, or it did not speak the expected protocol.                                                   |
| `PROXY_CONNECT_FAILED`     | `XrioError` | The proxy refused the tunnel with another non-2xx status. `details.status` holds it.                                              |
| `MODE_NOT_IMPLEMENTED`     | `XrioError` | Headed or headless mode is not implemented.                                                                                       |

The client's own error is kept as `cause`. There are no retries. Messages never include URL or proxy credentials.

Migration:

- HTML/Markdown callers now read `result.data`; JSON callers read `result.data.metadata` and `result.data.content`.
- `UNSUPPORTED_CONTENT_TYPE` and `MODE_NOT_IMPLEMENTED` are now `XrioError`s. Response fields moved from the error itself to `error.details`.
- Results and `UNSUPPORTED_CONTENT_TYPE` details carry a new `block` report.
- Timeouts reject with `TIMEOUT` instead of a native `TimeoutError`, invalid URLs with `INVALID_OPTIONS` instead of `ERR_INVALID_URL`, and network failures with the codes above instead of native `fetch` errors.
- http mode no longer uses native `fetch`, so requests look like Chrome on the wire and ambient proxy variables no longer apply.

The client resolves options, selects a document source by mode, and selects a content operation by format. The source and format mappings are independent. To implement a mode, add its source handler and update the mode mapping; HTTP loading and the scrape workflow do not need to change.

- `options.ts` owns native input validation, defaults, per-call mode resolution, and proxy URL parsing.
- `errors.ts` owns the error codes, `XrioError`, `isXrioError`, and URL redaction for messages.
- `deadline.ts` owns the per-scrape deadline and the one `AbortSignal` every stage observes.
- `sources/http.ts` is the only production module that imports `wreq-js` (`sources/http.test.ts` also imports `resolveProfile` to check that the pinned profile is the newest the binding offers); `sources/decode.ts` owns charset decoding.
- `proxy/relay.ts` owns proxy dialing, refusals, and failure attribution.
- `blocks/rules.ts` is the ruleset as typed data; `blocks/classify.ts` turns a response into a block report.
- `sources/` owns document loading and response handling, returning a `SourceDocument`.
- `content/formats.ts` exposes separate HTML, Markdown, and structured-content operations.
- `content/document.ts` owns shared HTML interpretation and URL-resolution rules.

From this package directory, run `vp run build` to generate the ESM entry point and TypeScript declarations in `dist/`. Run `vp run check` and `vp test` from the repository root to validate the workspace.
