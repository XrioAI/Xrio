# @xrio/core

Fetch an HTML page and return its HTML, Markdown, or structured content. Requires Node.js 24 or newer.

```ts
import { XrioClient } from "@xrio/core";

const xrio = new XrioClient({ browserPath: "/usr/bin/google-chrome" });

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

`format` is required. Every call returns a `ScrapeResult` with `{ data, url, status, headers, cookies, format, block, identity }`:

- `data`: an HTML or Markdown string, or `StructuredContent` for `json`.
- `url`: the final response URL after redirects.
- `status`: the actual HTTP response status, including non-2xx statuses.
- `headers`: a plain object with lowercase names and string values, typed `string | undefined` because a header the response did not send is absent. `set-cookie` is never included; use `cookies`.
- `cookies`: each `Set-Cookie` header value of the final response, in order and unparsed. Empty when the response set none.
- `format`: the requested format. Checking this field narrows the type of `data` in TypeScript.
- `block`: the block report described below. Detection never throws, and a challenge served as a 200 still reports a block.
- `identity`: the identity report described below. It says what Xrio configured and how much of it was observed.

For `json`, `data` retains the existing `StructuredContent` fields:

- `metadata`: final response `url`, `title`, `description`, and `language`. Missing descriptive metadata is `null`.
- `content`: `markdown`, plain `text`, `links: { text, href }[]`, and `images: { alt, src }[]`.

HTML preserves the decoded response body. Bodies are decoded with WHATWG rules: a byte-order mark first, then the `Content-Type` charset, then a `<meta>` charset in the first 1,024 bytes, then UTF-8. Unknown labels fall back to UTF-8, and `iso-8859-1` decodes as windows-1252, as browsers do. Markdown and text cover the whole body, including navigation, sidebars, footers, and `noscript` content. JSON uses the same Markdown conversion as `format: "markdown"`. Links and images retain duplicates and source order, including elements inside templates. Their URLs resolve against the final response URL and the first `<base href>` when present. Conversion uses `@mdream/js`.

The default mode is `headed`, so a client needs `browserPath` unless it picks another mode (see [Browser modes](#browser-modes)). `mode: "http"` fetches without a browser. Over HTTPS it sends the request a Chrome navigation would send: the TLS ClientHello, HTTP/2 SETTINGS, WINDOW_UPDATE and priority frames, and the header set and order come from a pinned Chrome profile in [`wreq-js`](https://github.com/sqdshguy/wreq-js), on Linux. The profile is Chrome 149, the newest the binding offers; Chrome 150 and later add ML-DSA signature algorithms, signature-algorithm GREASE and a trust-anchors extension that it cannot send yet, so the profile claims Chrome 149 throughout rather than mixing versions. A scheduled check (`scripts/check-http-identity.ts`) compares the HTTP/2 wire identity with a recorded Chrome 154 capture and flags the profile when it falls behind Chrome stable. HTTP/1.1 requests use Chrome's header order and name case and keep the connection alive, but they are not compared with a Chrome capture, and plain `http://` requests still carry the `sec-ch-ua`, `sec-fetch-*` and `br, zstd` values Chrome sends only to secure origins. Redirects are followed for up to 20 hops, cookies set on one hop are sent on the next, and `url` is the final URL. A body over 32 MiB after decompression (counted before charset decoding) rejects with `RESPONSE_TOO_LARGE`.

`proxy` takes an `http`, `https`, `socks5`, or `socks5h` URL, as a client default or per scrape. Credentials are percent-decoded once and never appear in messages. Both SOCKS schemes resolve names at the proxy, so target names never reach the local resolver. Requests go through a local relay that dials the proxy, so a 407, an unreachable proxy, and a refused tunnel report distinct codes. Without a proxy, the relay connects directly. The ambient `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` variables are ignored. Loopback and link-local targets are never sent through a proxy.

Configure a client default with `new XrioClient({ mode: "http" })` or override it on an individual scrape. Overrides never change the client.

### Browser modes

`headed`, the default, and `headless` require `browserPath`, the path to a Chrome or Chromium executable, version 150 or newer. Headed mode needs a display; on a Linux server, run under `xvfb-run`. An explicit browser-mode override must supply its own path. Each scrape launches a fresh Chrome with a fresh profile through Xrio's own client over Chrome's DevTools pipe, which sends only a fixed list of DevTools commands, navigates, waits for DOMContentLoaded, and captures the doctype and `documentElement.outerHTML`. The capture runs in an isolated world; Xrio's own code never runs in the page's main world and adds no init scripts. `url`, `status`, `headers`, and `cookies` describe the document that was captured, and statuses are data here too, so a 401 or 403 page is returned. If the page replaces its document during the capture, Xrio captures the replacement once. A captured document over 32 Mi UTF-16 code units rejects with `RESPONSE_TOO_LARGE`.

Current limits, lifted in later releases:

- `proxy` is not supported in browser modes yet. It rejects with `INVALID_OPTIONS` rather than connecting directly.
- JSON, XML, and PDF responses return the HTML of Chrome's viewer instead of `UNSUPPORTED_CONTENT_TYPE`. A download or an HTTP 204 rejects with `NETWORK_ERROR` and `details.netError` `net::ERR_ABORTED`.
- There is no challenge wait, and `waitFor`, `locale`, and `timezone` are not available yet.

`browserArgs` adds Chrome switches to every browser scrape of a client, for settings Xrio does not manage, such as `--no-sandbox` in a container that runs as root. Each entry is `--name` or `--name=value`, and any other entry rejects with `INVALID_OPTIONS`. Xrio appends them after its own switches and before the profile arguments. It rejects, naming the switch, any switch it sets itself or reserves for the identity: the language, screen, window, scale, user-agent, GL, WebRTC and automation switches, the fork's `--pxr-` and `--xrio-` switches, `--enable-features`, `--disable-features`, and the ones that start Chrome, choose its profile or proxy, load extensions or open its debugging channel, such as `--user-data-dir`, `--profile-directory`, `--guest`, `--headless`, `--proxy-server`, `--proxy-pac-url` and `--remote-debugging-port`. Of the switches Xrio sets, only the valueless ones from its Chrome baseline, such as `--disable-dev-shm-usage`, are accepted, and they are sent once. Xrio's own switches, such as `--disable-component-update`, `--headless` and `--mute-audio`, are refused. Only browser clients take them, and a scrape that passes `browserArgs` rejects with `INVALID_OPTIONS`.

```ts
const xrio = new XrioClient({ mode: "headless", browserPath, browserArgs: ["--no-sandbox"] });
```

`maxBrowsers` caps the browsers one client runs at once. It defaults to the CPU count or one browser per 0.5 GB of memory, whichever is smaller. Further scrapes queue, and time spent queued counts against `timeoutMs`; aborting a queued scrape removes it from the queue.

```ts
await using xrio = new XrioClient({ mode: "headless", browserPath, maxBrowsers: 4 });
```

`await xrio.close()`, or leaving an `await using` block, lets accepted scrapes, running or queued, finish under their own deadlines, and resolves once every browser has been torn down. If a Chrome outlives its teardown budget, a `teardown-incomplete` event says so and its profile is left for the startup sweep. A scrape started after `close()` rejects with `CLIENT_CLOSED`. Teardown always runs, even after a timeout: Chrome gets 2 seconds to close, then its process group is killed and its profile is deleted. Xrio installs no process signal handlers. If Node dies without closing, Chrome exits when its end of the debugging pipe closes, and the next process to launch a browser deletes profiles left behind for more than an hour.

Stage timings (`queue`, `launch`, `verify`, `navigation`, `capture`, `teardown`) are published on the `node:diagnostics_channel` channel `xrio:stage`, and internal events (the identity chosen for each browser, published as JSON before it launches so a failed scrape can still be attributed, browser launches, document rebinds, raw-header fallbacks, dropped request URLs, and an incomplete teardown or startup sweep) on `xrio:event`. Nothing is printed by default.

`timeoutMs` is one deadline for the whole scrape, covering queueing and launching a browser, connecting, redirects, reading the body or capturing the page, and building the result. It defaults to 60,000 and must be a positive integer no greater than 2,147,483,647. When it passes, the scrape rejects with an `XrioError` whose `code` is `TIMEOUT`. To cancel from an SDK or CLI, pass an `AbortController`'s signal:

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

### Identity report

`identity` says what Xrio configured for the scrape and how much of it was observed. It is not evidence that a site accepted the browser. Checking `identity.mode` narrows its type in TypeScript. A scrape that rejects carries no report, and the `identity-chosen` event (see the diagnostics channels above) names the identity its browser was launched with.

In http mode it is `{ mode: "http", locale, profile, coverage, tells }`. `profile` names the Chrome major and platform of the wreq profile, `{ chromeMajor: 149, platform: "linux" }`, and `locale` is the language its `Accept-Language` header names. `coverage.requestHeaders` is `unchecked`, because Xrio does not record the headers it sends.

In browser modes it is `{ mode, binary, exit, surfaces, observed, coverage, notes, tells }`:

- `binary.version`: the version Chrome reported at launch.
- `exit`: `{ route, facts }`. `route` is `direct` or `proxy`, and `facts` is `{ kind: "unknown" }` until Xrio observes proxy exits. It never holds a credential.
- `surfaces`: what each identity surface chose. `locale` holds the `tag` and Chrome's `languages`. `timezone` is `{ source: "host", zone }`, where `zone` is the `TZ` Xrio forwarded, or `null` when `TZ` was unset. `gpu` is `{ backend: "swiftshader", persona: null }` on Linux and `{ backend: "native" }` elsewhere. `window` is `{ source: "fixed", size }`. `screen` is `{ source: "fixed", size, workArea }` in headless mode and `{ source: "host" }` in headed mode, where the real display decides. `leaks` turns DNS-over-HTTPS and network prediction off, and `automation` is `null`, because it chooses nothing.
- `observed`: what Chrome presented on its first `about:blank` before navigation: `timeZone` and its January and July `offsets`, `intlLocale`, `languages`, `userAgent`, `webdriver`, `screen`, `window`, the media features `colorScheme`, `reducedMotion`, `pointer`, `hover` and `anyPointer`, and `maxTouchPoints`. On a secure origin (HTTPS or loopback) it also holds what Xrio read in an isolated world after capturing the document: `deviceMemory`, the high-entropy `clientHints` (architecture and bitness included), whether `battery` is available, and whether `webgpu` is present. Media devices are not read, because the first `enumerateDevices()` call of a fresh Chrome takes about 50 ms on Linux, and `coverage.mediaDevices` says so as `not-observed`. The read never touches the page's own scripts, never changes the captured document, and is capped at 250 ms or half the remaining deadline, whichever is shorter, inside the `capture` stage, and is skipped when that budget is under 50 ms. Each of these is `null` when it was not read.
- `coverage`: one entry per identity surface, such as `timezone`, `screen`, `clientHints`, `deviceMemory`, `webglStrings`, `fonts`, `requestHeaders` and `webrtc`. Each is `{ state: "observed" }` when this launch read it, `{ state: "cached", key, ageMs }` for compatibility evidence from an earlier probe, or `{ state: "unchecked", reason }`. The reasons are `not-observed` (no read covers it), `lanes-only` (only Xrio's own test runs check it, as for WebGL pixels), `no-request-log`, `insecure-origin` (the secure-context surfaces on a plain `http://` page), `read-failed` (the read threw, timed out or returned something malformed, and the scrape still resolved) and `no-time` (too little of the deadline remained, so the read was skipped).
- `notes`: expectations that did not hold but do not fail the launch, each `{ surface, field, expected, observed }`. `field` here, and in `BROWSER_LAUNCH_FAILED.details.mismatches[].field`, is the name the read uses, such as `screenWidth`, `outerWidth`, `zone` or `zoneOffsets`, which differs from the nesting of `observed` (`screen.width`, `window.outerWidth`, `timeZone`, `offsets`).
- `tells`: weaknesses the facts show, such as `headless-token` for stock headless Chrome's user agent, `no-taskbar`, `display-implausible`, `unmeasured-chrome` and `zone-unverified`.

### Block report

`block` is `{ verdict, vendor, evidence, passedChallenges, challenge }`. The rules are data (`blocks/rules.ts`), and no vendor is named in code.

- `verdict`: `ok`, `suspect`, `blocked`, `queued` (a Queue-it waiting room, which is not a block and should not be retried harder), or `unknown` (classification itself failed).
- `vendor`: the vendor whose evidence decided the verdict, or `null`.
- `evidence`: every rule that fired, ordered by tier, each `{ rule, tier, family, vendor, detail }`. `detail` is at most 160 characters. It never includes cookie values, query-string values (only the names of parameters that have one), or the value of a header that matters only by its presence.
- `passedChallenges`: rules that prove a challenge was issued but did not decide, because the captured document is not shaped like an interstitial. The challenge was passed, or the page was served around it.
- `challenge`: `null` in http mode. Browser modes will report their challenge wait here, with its `outcome` and one entry per round; until that wait exists, it is `null` there too.

Evidence has tiers. E0 decides alone. E1 decides alone. Its markup rules fire only on a document small enough to be an interstitial (at most 50,000 characters of HTML and 5,000 of text, counted as code points with entities decoded), and the vendor sensors that also load on working pages need fewer than 100 text characters as well; an E1 challenge cookie needs only an HTML response. Every pass over the markup, the request URLs and the cookies runs in time linear in its input, and markup rules that apply at any size read only the first 1 MiB of the document, so a hostile page cannot stall classification. E2 is weak, and decides `blocked` only when two signals come from different families; one family is `suspect`. Status codes are E2 at most, so a 403 alone is never `blocked`. E3 suppressors cancel E1 and E2 for non-HTML, JSON and XML bodies. These page-shape thresholds come from [crawl4ai](https://github.com/unclecode/crawl4ai) (Apache-2.0).

Responses that are not HTML are classified without a body, and the report rides on the `UNSUPPORTED_CONTENT_TYPE` error's `details.block`. Only E0 evidence that needs no body, such as a challenge header or a waiting-room URL, can decide them; status and request-log evidence is listed but does not decide, and the challenge cookie, which needs an HTML response, is not checked.

In browser modes the classifier sees every request URL from the page's frames and workers. In http mode the request URLs are only the redirect chain, so two limits apply:

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

| Code                       | Error class | When                                                                                                                                                                              |
| -------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_OPTIONS`          | `TypeError` | An option is invalid: format, mode, browser path, timeout, proxy, `maxBrowsers`, `browserArgs`, a browser-mode proxy, or a URL that is relative, not HTTP(S), or has credentials. |
| `UNSUPPORTED_CONTENT_TYPE` | `XrioError` | The response is not HTML. `details` holds the response details, a body preview, and the block report.                                                                             |
| `TIMEOUT`                  | `XrioError` | The scrape deadline (`timeoutMs`) passed.                                                                                                                                         |
| `NETWORK_ERROR`            | `XrioError` | DNS failure, refused or reset connection, protocol error, or a proxy that could not reach the target (502–504). Browser modes add `details.netError`, Chrome's `net::ERR_*` name. |
| `TLS_CERTIFICATE_INVALID`  | `XrioError` | The certificate was rejected.                                                                                                                                                     |
| `TOO_MANY_REDIRECTS`       | `XrioError` | More than 20 redirects.                                                                                                                                                           |
| `RESPONSE_TOO_LARGE`       | `XrioError` | The decompressed body is over 32 MiB, or a browser capture is over 32 Mi UTF-16 code units.                                                                                       |
| `PROXY_AUTH_FAILED`        | `XrioError` | The proxy answered 407, or a SOCKS5 proxy rejected the credentials.                                                                                                               |
| `PROXY_UNREACHABLE`        | `XrioError` | Xrio could not connect to the proxy, or it did not speak the expected protocol.                                                                                                   |
| `PROXY_CONNECT_FAILED`     | `XrioError` | The proxy refused the tunnel with another non-2xx status. `details.status` holds it.                                                                                              |
| `BROWSER_LAUNCH_FAILED`    | `XrioError` | Chrome did not start, is older than 150, or failed its pre-navigation identity check. `details.stderr` holds its output tail, `details.mismatches` each fatal mismatch.           |
| `BROWSER_CRASHED`          | `XrioError` | The browser or the page's renderer died mid-scrape.                                                                                                                               |
| `CLIENT_CLOSED`            | `XrioError` | `scrape()` was called after `close()`.                                                                                                                                            |

The client's own error is kept as `cause`. There are no retries. Messages never include URL or proxy credentials.

Migration:

- HTML/Markdown callers now read `result.data`; JSON callers read `result.data.metadata` and `result.data.content`.
- `UNSUPPORTED_CONTENT_TYPE` is now an `XrioError`. Response fields moved from the error itself to `error.details`.
- `MODE_NOT_IMPLEMENTED` is removed: `headless` and `headed` now scrape.
- The default mode is now `headed`, which requires `browserPath`. Pass `mode: "http"` to keep fetching without a browser.
- `XrioClient` gains `close()` and `[Symbol.asyncDispose]`. Close a client that ran browser scrapes to release its browsers.
- Results and `UNSUPPORTED_CONTENT_TYPE` details carry a new `block` report.
- Timeouts reject with `TIMEOUT` instead of a native `TimeoutError`, invalid URLs with `INVALID_OPTIONS` instead of `ERR_INVALID_URL`, and network failures with the codes above instead of native `fetch` errors.
- http mode no longer uses native `fetch`, so requests look like Chrome on the wire and ambient proxy variables no longer apply.

The client resolves options, loads the document with `sources/http.ts` in http mode or with its shared, bounded set of browsers (`sources/browser/`) in the browser modes, and selects a content operation by format. Loading and content conversion are independent.

- `options.ts` owns native input validation, defaults, per-call mode resolution, and proxy URL parsing.
- `errors.ts` owns the error codes, `XrioError`, `isXrioError`, and URL redaction for messages.
- `deadline.ts` owns the per-scrape deadline and the one `AbortSignal` every stage observes.
- `sources/http.ts` is the only production module that imports `wreq-js` (`sources/http.test.ts` also imports `resolveProfile` to check that the pinned profile is the newest the binding offers); `sources/decode.ts` owns charset decoding.
- `proxy/relay.ts` owns proxy dialing, refusals, and failure attribution.
- `blocks/rules.ts` is the ruleset as typed data; `blocks/classify.ts` turns a response into a block report.
- `sources/` owns document loading and response handling, returning a `SourceDocument`.
- `sources/browser/` owns browser modes: `launch-plan.ts` plans Chrome's argv, environment, and profile files, and refuses the caller's switches that it manages; `browser-process.ts` owns scratch directories, Chrome's spawn, and the startup sweep; `group-lifetime.ts` owns Chrome's process group and counts it as gone once no member is alive, so zombies that nothing reaps do not hold up teardown; `chrome-scope.ts` owns one Chrome's scratch directory and process group and retires both; `port.ts` is the driver interface, implemented by `cdp/driver.ts` over the DevTools pipe; `render.ts` navigates and captures; `browsers.ts` limits concurrency.
- `diagnostics.ts` publishes stage timings and internal events.
- `content/formats.ts` exposes separate HTML, Markdown, and structured-content operations.
- `content/document.ts` owns shared HTML interpretation and URL-resolution rules.

From this package directory, run `vp run build` to generate the ESM entry point and TypeScript declarations in `dist/`. Run `vp run check` and `vp test` from the repository root to validate the workspace.
