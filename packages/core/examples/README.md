# Examples

These scripts use the public `@xrio/core` package and Node.js 24+. Follow the [installation guide](../README.md#install), then copy the scripts you want into your project. Set `"type": "module"` in your project's `package.json`; Node runs these TypeScript files directly.

```sh
node markdown.ts
```

From a repository checkout, build the package once so its public exports resolve, then run an example:

```sh
vp install
vp run --filter @xrio/core build
vp node packages/core/examples/markdown.ts
```

| Example                            | What it demonstrates                                        | Setup                                                     |
| ---------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| [html.ts](html.ts)                 | Raw response HTML                                           | None                                                      |
| [markdown.ts](markdown.ts)         | Page content as Markdown                                    | None                                                      |
| [json.ts](json.ts)                 | Structured content and response metadata                    | None                                                      |
| [modes.ts](modes.ts)               | Rendered content, selector waits, headed and HTTP overrides | `XRIO_BROWSER_PATH`, plus a display for the headed scrape |
| [requests.ts](requests.ts)         | Custom HTTP headers and seed cookies                        | None; uses a harmless example cookie                      |
| [proxy.ts](proxy.ts)               | A client proxy and optional explicit config path            | `XRIO_PROXY`                                              |
| [sessions.ts](sessions.ts)         | Persistent named sessions, visit history, and a pool        | `XRIO_BROWSER_PATH`                                       |
| [errors.ts](errors.ts)             | HTTP status, block reports, and typed errors                | Optional URL argument                                     |
| [cancellation.ts](cancellation.ts) | Caller cancellation with `AbortController`                  | None; the request may finish before cancellation          |

The scripts contact `https://example.com`. Browser paths must point to Chrome/Chromium 150+. For example:

```sh
XRIO_BROWSER_PATH=/absolute/path/to/chrome node modes.ts
XRIO_BROWSER_PATH=/absolute/path/to/chrome node sessions.ts
node errors.ts https://example.com
```

The sessions example persists profiles and its database under `./xrio-example-state`, relative to your working directory. Run it again from the same directory to reuse them. It leaves the state intact; remove sessions with `client.sessions.delete(name)` when finished.

## Proxies and config

`XRIO_PROXY` is an environment variable read by `proxy.ts`, not by the library. Supply a concrete URL from your provider; the client option does not accept `{session}` placeholders. Percent-encode reserved characters in credentials. Avoid committing credentials or sharing output that contains cookies or private page content.

Xrio discovers config in the working directory, not beside a script. For a minimal config, save this as `xrio.config.json` in your project:

```json
{
  "scrape": { "retries": 2 }
}
```

Then run `proxy.ts`, using a shell environment that already has `XRIO_PROXY` set:

```sh
node proxy.ts ./xrio.config.json
```

The included [xrio.config.json](xrio.config.json) is a comprehensive configuration reference, also checked against the schema by the test suite. Its proxy credentials are placeholders and its host settings deliberately pin identity values. Copy only the settings you need.

For provider-managed sticky sessions, put the provider's URL template in `config.proxy.url` with its `proxy.session` settings, then create a client without a `proxy` option: client/scrape proxy options override the configured URL entirely. See [proxy configuration](../docs/reference.md#proxy-configuration-and-identity).

Without a config file, Xrio emits an `XRIO_NO_CONFIG` warning and uses defaults.
