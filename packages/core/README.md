# @xrio/core

Fetch an HTML page and return its HTML, Markdown, or structured content. Requires Node.js 24 or newer.

```ts
import { XrioClient } from "@xrio/core";

const xrio = new XrioClient();

const page = await xrio.scrape({
  url: "https://example.com",
  format: "json",
  timeoutMs: 60_000,
});

page.metadata.title;
page.content.markdown;
```

`format` is required. `html` and `markdown` return strings; `json` returns a `JsonPage` object with:

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
const markdown = await pending;
```

Non-success HTTP statuses and responses without a `text/html` content type reject. Network, timeout, and cancellation errors propagate from native fetch. There are no retries.

From this package directory, run `vp run build` to generate the ESM entry point and TypeScript declarations in `dist/`. Run `vp run check` and `vp test` from the repository root to validate the workspace.
