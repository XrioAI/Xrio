# Development

For installation and usage, see the [README](../README.md).

The client resolves options into a scrape intent, has the coordinator load the document through `sources/http.ts` in http mode or one admitted browser (`sources/browser/`) in the browser modes, and selects a content operation by format. Loading and content conversion are independent.

- `options.ts` owns native input validation, defaults, per-call mode resolution, and proxy URL parsing.
- `errors.ts` owns the error codes, `XrioError`, `isXrioError`, and URL redaction for messages.
- `deadline.ts` owns the per-scrape deadline and the one `AbortSignal` every stage observes.
- `sources/http.ts` loads target pages with `wreq-js`; `proxy/info.ts` uses it for metadata. `sources/decode.ts` owns charset decoding.
- `proxy/relay.ts` owns proxy dialing, refusals, and failure attribution.
- `proxy/` owns proxy configuration, session state, and metadata lookup contracts.
- `blocks/rules.ts` is the ruleset as typed data; `blocks/classify.ts` turns a response into a block report.
- `coordinator.ts` runs each scrape from its `ScrapeIntent` (`intent.ts`): a session hold (`sessions/session.ts`), an admission slot (`admission.ts`), the visit plan and the Humanizer's identity, then one answer (`answer.ts`) whose errors `outcome.ts` maps once. Sources and the Humanizer consume complete plans and never import the managers above them; lint enforces it.
- `sources/` owns document loading and response handling, returning a `SourceDocument` for a planned visit.
- `sources/browser/` owns browser modes: `launch-plan.ts` plans Chrome's argv, environment, and profile files, and refuses the caller's switches that it manages; `browser-process.ts` owns scratch directories, Chrome's spawn, and the startup sweep; `group-lifetime.ts` owns Chrome's process group and counts it as gone once no member is alive, so zombies that nothing reaps do not hold up teardown; `capabilities.ts` detects the fork and keeps its facts per host; `chrome-scope.ts` owns one Chrome's scratch directory and process group and retires both; `port.ts` is the driver interface, implemented by `cdp/driver.ts` over the DevTools pipe, with `cdp/pointer.ts` planning its one click gesture; `render.ts` navigates and captures; `challenge.ts` waits out challenges and decides when to click a Cloudflare checkbox, which `turnstile.ts` locates; `browsers.ts` runs one planned visit.
- `diagnostics.ts` publishes stage timings and internal events.
- `content/formats.ts` exposes separate HTML, Markdown, and structured-content operations.
- `content/document.ts` owns shared HTML interpretation and URL-resolution rules.

From this package directory, run `vp run build` to generate the ESM entry point and TypeScript declarations in `dist/`. Run `vp run check` and `vp test` from the repository root to validate the workspace.
