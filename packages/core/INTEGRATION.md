# Connecting the proxy manager to scrapes

PR #13 integrates the proxy manager with main (`b0f9ad933d140295c999858b927de8bea0cb0bf1`) under the decisions below. PRs #9 and #14 are already in that main revision. #10's fork build is outside this change. Automatic rotation and the other deferred items remain outside this integration.

## Review findings addressed

The [original review](https://github.com/XrioAI/Xrio/pull/13#issuecomment-6026831243) and [follow-up discussion](https://github.com/XrioAI/Xrio/pull/13#issuecomment-6034928537) informed this integration. The user's grilling decisions supersede older proposals about proxy overrides, rotation, and identity pins.

- Retained main's enhanced relay at `src/proxy/relay.ts`. Metadata and HTTP use token admission; Chrome uses loopback admission.
- Connected `XrioClient` configuration loading to `createScrapes`, rather than leaving the manager standalone.
- Filled the observed-exit contract with the accepted provider's actual destination and timestamp, plus the selected route's key and generation.
- Activated proxy timezone following and Humanizer-owned supported-locale selection before font evidence is claimed.
- Removed four public identity controls and their obsolete option parsers. Kept the Humanizer's internal identity/replay contracts and client-only `browserArgs`.
- Kept automatic rotation, retries, and exit caching deferred. The route generation remains zero while the coordinator keeps one initial configured connection. Password-only rotation will need a generation increment when rotation is connected; passwords must stay out of route hashes.

## Interface ownership

| Producer → consumer              | Contract                                      | Responsibility                                                                                                                                               |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `XrioClient` → `createScrapes`   | `XrioConfig`                                  | Discover once per client; pass values, never file access, to the coordinator.                                                                                |
| `options.ts` → coordinator       | `ScrapeIntent.route`                          | Resolve concrete scrape/client proxies, in that order; reject explicit templates and removed identity arguments.                                             |
| Coordinator → `ProxyManager`     | `config.proxy`                                | Construct once and expand the initial configured session. No outcome-driven rotation.                                                                        |
| Coordinator → `lookupProxyInfo`  | Selected `ProxyEndpoint`, held deadline       | Snapshot the endpoint before awaiting; use the same endpoint for metadata and the target source.                                                             |
| Lookup → route helper            | `ProxyObservation`                            | Return one complete observation with provider, timestamp, and lookup destination. Close the metadata session and relay on success, failure, or cancellation. |
| Coordinator → Humanizer          | Locale hint, exit facts, route kind           | Humanizer selects the supported locale or `en-US`; browser timezone follows the exit. Coordinator does not choose fingerprint values.                        |
| Humanizer → font evidence/source | Selected locale, `IdentityPlan` or `HttpPlan` | Claim fonts for the final locale; HTTP receives only locale-derived headers.                                                                                 |
| Source → coordinator             | Document and cleanup completion               | Preserve answer-once semantics, deadline/error handling, credential isolation, and browser cleanup.                                                          |

The flow stays in the existing coordinator:

```text
client loads config → options resolve explicit proxy → session hold → admission
  → select explicit proxy or configured connection
  → look up proxy metadata (skip for direct)
  → Humanizer selects locale
  → HTTP plan, or host/font evidence + browser identity plan
  → source loads document → answer → owned cleanup
```

Sources and the Humanizer must not import proxy/session managers or perform discovery. The `calls-go-down` lint rule now covers the real `proxy/manager.ts` and `proxy/info.ts` modules as well as route/session modules. The relay remains a shared transport dependency.

## Validation

Validated on 2026-10-07:

- `vp run check` passed formatting, lint, workspace type checks, and Knip.
- `vp test --project unit` passed **1,554 tests** across 51 files, with **5 existing tests skipped**. Tests for the removed public controls were replaced with rejection checks; obsolete parser tests were removed.
- `XRIO_TEST_MODES=headless vp test --project browser packages/core/src/browser-proxy.browser.test.ts` passed **22 tests**, including actual Chrome observation of `de-DE` languages and `Europe/Berlin` timezone.
- `vp run build` in `packages/core` passed, emitting the ESM bundle and TypeScript declarations.

Coverage includes the public client's CWD discovery and proxy precedence, unchanged config, concurrent route observations, supported and unsupported locale inference, real HTTP relay delivery, blocked results without retries or rotation, lookup budgets and errors, cancellation socket cleanup, and pre-launch failure. Manager rotation methods are unchanged. Main's relay and source implementations are unchanged.

Transport tests use fixed geolocation observations, and public-client lookup tests use local failing/stalled proxies. Headed mode and live residential-provider stability were not validated.

## Grilling decisions

The selected outcome is a working config/proxy/metadata/Humanizer/source flow through the existing coordinator. Making the standalone manager mergeable is not the whole outcome. Keep the solution in the existing modules, with no second controller or new browser/host manager.

### Proxy selection and ownership

- Select the proxy URL with this priority: **scrape argument → client argument → config file**. If none is supplied, use the existing direct route.
- An override selects a whole route; it never edits the config file or inherits the configured provider's session format/length.
- A `{session}` template in the config signals eligibility for managed rotation. An explicit client/scrape proxy is always unmanaged, even if it names the same endpoint as the configured route.
- Reject `{session}` in an explicit client/scrape argument with `INVALID_OPTIONS` and a useful message: “Proxy templates are only supported in xrio.config. Pass a concrete proxy URL to the client or scrape method.”
- Keep `shouldRotateSession` and `changeSession` unchanged. They are intended for later use. Do not add automatic outcome-driven rotation in this integration. Initial template expansion by manager construction remains existing behavior.
- Do not add automatic retries: a blocked or failed scrape is not silently repeated. The existing session revisit mechanism is a separate contract and is not repurposed here.

### Identity and public options

- Connect the selected proxy's metadata to the Humanizer. The manager supplies the inferred locale; the Humanizer owns the supported-locale check and final selection.
- Use a supported inferred locale, falling back to `en-US` when the inference is unsupported. Direct requests keep the existing locale default.
- Browser timezone follows the observed proxy timezone; direct browser requests retain the host timezone. Activate the existing exit-following policy explicitly.
- HTTP consumes only the resolved locale through `Accept-Language`; it does not receive timezone, display, hardware, or browser arguments. Proxy-derived HTTP locale therefore also needs proxy metadata.
- Remove `locale`, `timezone`, `display`, and `hardware` from client/scrape options. File-based replacement for these controls is deferred. Until then, locale/timezone follow the rules above, and display/hardware use existing defaults. Reject removed arguments with an explanatory `INVALID_OPTIONS` instead of silently ignoring them.
- Retain `browserArgs` as a client-only option with its existing validation and behavior; its removal is deferred.
- Retain the other current API properties: `proxy`, `mode`, and the existing `browserPath` rules; client-only `maxBrowsers` and `cacheDir`; scrape-only `url`, `format`, `timeoutMs`, and `signal`.
- The future direction is config-owned host settings. Do not introduce a `browser` or `host` section in this change, or apply an unvalidated arbitrary config section to browser launch inputs.

### Integration requirements retained from the review

- Load config once per client, using the current loader. Pass values through `createScrapes`; managers do not discover files themselves.
- Repair main/PR #13 relay compatibility. Keep one relay implementation with the current browser behavior; metadata uses token admission and Chrome uses loopback admission.
- Bind lookup facts to the exact selected connection and pass that same endpoint into the source plan. Populate observation provenance truthfully; do not substitute current manager state after an await or fabricate an observation for the target destination.
- Preserve the shared lookup budget, typed proxy failures, cancellation, and the existing fail-before-browser-launch behavior. A failed proxy lookup never falls back to direct/local facts.
- Let the Humanizer select locale before font evidence is claimed. Retain identity verification, credential isolation, answer-once semantics, and owned cleanup.
- Preserve existing proxy/input validation. Broader config validation is deferred, not removed.

### Working-directory research

Seven executable checks confirmed the behavior of `loadXrioConfig` on Node 24.21.0. The loader defaults to `process.cwd()`, checks only that directory for `xrio.config.ts`, `.mts`, `.js`, and `.mjs`, and does not search parents. No file returns `{}`; multiple matching files throw `INVALID_OPTIONS`.

| Working directory                     | Result after connecting the existing loader   |
| ------------------------------------- | --------------------------------------------- |
| Project root containing config        | Loads that config                             |
| Project subdirectory                  | Does not discover the parent project's config |
| Unrelated directory without config    | Returns `{}`                                  |
| Unrelated directory containing config | Loads that directory's config                 |

The calling script's location and the installed Xrio package's location do not change this behavior. `createRequire(import.meta.url)` does not change the discovery root: the discovered file is loaded by its absolute path. Imports inside that file resolve relative to the file. Repeated loads retain Node's module-cache behavior; there is no hot reload.

The internal loader already accepts an explicit directory, but the public client has no config-location option. Working-directory policy is deferred: retain this current discovery behavior and do not add `configDir`, `configPath`, parent traversal, or caller-location inference in this change.

### Acceptance criteria for the selected scope

1. The real client/coordinator path honors scrape → client → config proxy precedence, leaves config unchanged, and keeps explicit routes unmanaged. Only config templates are expanded; explicit templates reject with the intended message.
2. Lookup and target traffic use the same selected endpoint. Supported inferred locale reaches browser and HTTP plans, unsupported inference falls back to `en-US`, and proxy timezone reaches browser planning.
3. Removed public options fail type checks and reject clearly for JavaScript callers. No replacement host-config section is silently implemented. Remaining public options preserve their existing behavior.
4. Proxy failures, invalid metadata, timeout, and cancellation preserve their existing errors and prevent browser launch where applicable. Direct routes make no proxy lookup. Failed work releases owned resources.
5. No scrape result calls the rotation methods, creates a proxy retry loop, or activates a cache. Existing manager method tests remain valid.
6. Existing lifecycle and real-browser proxy tests remain green. Add focused tests across the newly connected boundaries; module-local tests alone do not establish completion.

## Deferred

1. **Xrio config validation.** Broader configuration schema and validation design. Retain the current root/proxy guards and input validation needed for this integration.
2. **Naming schema for the config file.** `browser` does not express the full scope of the settings; `host` is the intended direction. Final section names and structure remain deferred.
3. **File-based host settings.** Add configuration support for `locale`, `timezone`, `display`, `hardware`, and `browserArgs` later. `locale`, `timezone`, `display`, and `hardware` have been removed from the public client/scrape options.
4. **Working-directory and discovery policy.** Define discovery for external processes, subdirectories, and service/worker entry points later, including any explicit config-location option or traversal policy. The present loader remains CWD-only.
5. **Rotation wiring and its outcome policy.** Leave `shouldRotateSession` and `changeSession` untouched for later consumption. Resolve generation handling across rotations and stale outcomes when adding that wiring; the review's password-only rotation finding remains relevant then.
6. **Automatic retries.** No hidden repeat of a blocked/failed scrape. Any later retry policy must share the original deadline and preserve the existing answer/cleanup contract.
7. **Exit-fact caching and bounded connection history.** Keep lookups fresh and retain the manager's current issued-connection history. Agree on freshness, provenance, and retention requirements before changing either behavior.
8. **Removal of `browserArgs`.** Keep the existing client-only argument and its validation for now. Moving it out of the public API is deferred.
