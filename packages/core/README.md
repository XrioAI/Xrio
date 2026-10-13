# @xrio/core

Scrape web pages as HTML, Markdown, or structured content. Fetch directly over HTTP, or use Chrome to render JavaScript, wait for content, and reuse browser sessions.

Requires **Node.js 24 or newer**. Releases are experimental and distributed as GitHub release assets; the package is not published to the npm registry yet.

## Install

Download the library `.tgz` and `SHA256SUMS` from the same [GitHub release](https://github.com/XrioAI/Xrio/releases). Replace the version placeholder with your downloaded filename:

```sh
sha256sum --ignore-missing -c SHA256SUMS
npm install ./xrio-core-<version>.tgz
```

For browser modes, also download the Chromium `.tar.zst` from that release. The supplied browser targets **Linux x64**; Ubuntu 22.04 x64 was validated. It needs Linux runtime libraries and `zstd` for extraction. Generated personas and a custom font stack are not included.

```sh
sha256sum --ignore-missing -c SHA256SUMS
mkdir -p xrio-browser
tar --zstd -xf ./xrio-chrome-<chromium-version>-v<fork-version>-linux.tar.zst -C xrio-browser --strip-components=1
./xrio-browser/chrome --version
```

## First scrape

```js
import { XrioClient } from "@xrio/core";

const xrio = new XrioClient({ mode: "http" });

try {
  const result = await xrio.scrape({
    url: "https://example.com",
    format: "markdown",
  });

  console.log(result.data);
  console.log(result.status, result.url, result.block.verdict);
} finally {
  await xrio.close();
}
```

## Choose a mode and output

| Mode               | Use it for                                     | Requirements                                                  |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| `http`             | HTML available without running JavaScript      | No browser needed                                             |
| `headless`         | JavaScript-rendered pages and browser sessions | `browserPath` pointing to Chrome/Chromium 150+                |
| `headed` (default) | Browser scraping with a visible window         | `browserPath` and a display; Linux servers can use `xvfb-run` |

Set the mode explicitly when creating a client. A scrape inherits that mode and browser path; an explicit override to `headless` or `headed` needs its own `browserPath`.

```js
import { XrioClient } from "@xrio/core";

const xrio = new XrioClient({
  mode: "headless",
  browserPath: "/absolute/path/to/xrio-browser/chrome",
  maxBrowsers: 4,
});

try {
  const result = await xrio.scrape({
    url: "https://example.com",
    format: "json",
    waitFor: { selector: "p" },
    timeoutMs: 60_000,
  });

  console.log(result.data.metadata.title);
  console.log(result.data.content.markdown);
} finally {
  await xrio.close();
}
```

`waitFor` is browser-only and waits for a selector to match for 500 ms. `timeoutMs` defaults to 60 seconds and covers the whole scrape, including queueing and retries. Pass an `AbortSignal` as `signal` to cancel.

Every scrape requires a `format`:

| Format     | `result.data`                                                                                |
| ---------- | -------------------------------------------------------------------------------------------- |
| `html`     | Response HTML in HTTP mode; serialized DOM in browser modes                                  |
| `markdown` | Markdown for the whole page, including navigation and footers                                |
| `json`     | `metadata` (URL, title, description, language) and `content` (Markdown, text, links, images) |

`json` structures an HTML page; it does not fetch a JSON API or extract a custom schema. Missing descriptive metadata is `null`.

All results include `url`, `status`, `headers`, `cookies`, `format`, `block`, `identity`, and `attempts`. Read content from `result.data`. Headers have lowercase names; `result.cookies` contains the final response's raw `Set-Cookie` values. See the [result reference](docs/reference.md#results-and-content).

## Common options

- **Proxies:** pass `proxy` on the client or a scrape. HTTP, HTTPS, SOCKS5, and SOCKS5H URLs are supported. Ambient proxy environment variables are ignored. Provider `{session}` templates belong in the config file.
- **Requests:** `cookies` accepts `Set-Cookie` strings in all modes for anonymous scrapes. Custom `headers` require `mode: "http"` on the scrape; identity headers and `cookie` are managed by Xrio.
- **Sessions:** set `session: "catalog"` on browser scrapes to preserve cookies, storage, and browser identity across calls and process restarts. Sessions cannot use HTTP mode or seed cookies. Use `session: { pool: "catalog", size: 4 }` for a pool.
- **Concurrency:** reuse one client. `maxBrowsers` limits concurrent browser scrapes; additional calls queue within their deadline.

Sessions persist on disk. Use a dedicated `stateDir` to choose where their profiles and database live. Session data can contain cookies and proxy credentials; see [session storage and lifecycle](docs/reference.md#sessions).

Xrio reads `xrio.config.ts`, `.mts`, `.js`, `.mjs`, or `.json` from the working directory once when the client is constructed. Pass `configFile` for a file elsewhere. With no config, it uses defaults and emits an `XRIO_NO_CONFIG` warning. A minimal `xrio.config.json` enables retries:

```json
{
  "$schema": "https://xrio.com/xrio.schema.json",
  "scrape": { "retries": 2 }
}
```

Retries default to zero and share the scrape's deadline. [Configuration](docs/reference.md#proxy-configuration-and-identity) also controls proxy sessions and host identity settings.

The public schema provides editor completion and validation without a local installation. It follows the latest landing deployment; use `"$schema": "./node_modules/@xrio/core/xrio.schema.json"` to match your installed package version exactly.

## Handle failures and blocked pages

HTML responses with HTTP 403, 404, or 500 still return a result. Check `result.status` and `result.block.verdict`: a challenge can return HTTP 200. A `queued` verdict means a waiting room; retrying more aggressively is inappropriate. Browser modes attempt to wait through recognized challenges, but access is not guaranteed.

Invalid options, network failures, timeouts, and unsupported content types reject. Xrio accepts HTML/XHTML pages; JSON APIs, PDFs, and other response types produce `UNSUPPORTED_CONTENT_TYPE`.

```js
import { isXrioError, XrioClient } from "@xrio/core";

const xrio = new XrioClient({ mode: "http" });

try {
  const result = await xrio.scrape({ url: "https://example.com", format: "html" });
  console.log(result.status, result.block.verdict);
} catch (error) {
  if (isXrioError(error)) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
} finally {
  await xrio.close();
}
```

`isXrioError` also recognizes invalid-option errors. Cancellation rejects with the signal's reason. See [error codes and block reports](docs/reference.md#block-report) for details.

## Examples and reference

Start with the [examples guide](examples/README.md): output formats, browser waits and mode overrides, request headers/cookies, proxies/config, sessions/pools, errors, and cancellation.

The [API reference](docs/reference.md) covers configuration, identity reports, session administration, limits, and migration notes. Repository contributors can use the [development notes](docs/development.md).
