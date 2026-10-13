# @xrio/core

## 0.3.0

### Minor Changes

- 9ddddba: `identity.observed.batteryState` now also holds the page's `chargingTime` and `dischargingTime` from `getBattery()`, with `null` for a time Chrome reports as `Infinity`.
- bc393e1: A browser that presents a laptop GL persona over SwiftShader on a fork listing the `battery-status` knob now presents a battery drawn from its seed, full and plugged in, discharging or charging, sent as `--xrio-battery-status` and reported as `identity.surfaces.battery`, with a `battery-drift` tell and a note when the page shows another battery; native GPUs, desktops, stock Chrome and forks without the knob keep Chrome's own battery and report `{ source: "host" }`. The `form-factor-battery-skew` tell is removed, because a plugged-in, full laptop reads the same as a machine with no battery.

### Patch Changes

- 22f9db3: Fork launches no longer fail with `must belong to this user with mode 0700` after a stock headless scrape first wrote to an empty host cache, because Xrio now creates missing cache directories with mode 0700 instead of the usual 0755 or 0775 the umask gives (delete a host cache directory an earlier version left that way).

## 0.2.0

### Minor Changes

- 2584dd3: Retry a page that reads `blocked` in an anonymous scrape on a new proxy session with a new device when `scrape.retries` allows it and the scrape routes through a `config.proxy.url` with a `{session}` placeholder, and report every scrape's attempts and fresh exits as `result.attempts`.
- 53e71e5: An http scrape whose exit cannot change, a direct route or a `config.proxy.url` with a `{session}` placeholder, now reuses the connections an earlier scrape of the same client left open for up to 30 s, so a repeat scrape of an origin skips the TCP, proxy CONNECT and TLS handshakes; scrapes through an explicit `proxy` still connect afresh.
- fc78551: Browsers that render on SwiftShader now turn on the Xrio fork's seeded canvas and audio noise, with a fork seed drawn from each identity's seed, and report it as `identity.surfaces.noise`; stock Chrome and forks without the noise knobs carry the `noise-unhonored` tell. `host.noise` in `xrio.config` (`auto`, `on` or `off`) forces it either way.
- 2d5d92f: Browser scrapes click the Turnstile checkbox of a Cloudflare challenge that has not passed by itself after 6 seconds, and report the clicks in `block.challenge.clicks`.

### Patch Changes

- 1dea016: Report Akamai's sec-cpt challenge page as a blocked Akamai challenge, and wait for the page to reload itself before the browser modes capture it.
- 2432b6d: Markdown conversion of a page with many code blocks now takes linear time, because the package bundles a patched `@mdream/js` 1.7.2 instead of installing it as a dependency.
- e9a7dec: Headless scrapes on stock Chrome or Chromium now present headed Chrome's user agent to the page, its frames, every kind of worker and each request, with the browser's own client hints.
- b609eb6: A proxied browser scrape of an https page now opens its tunnel to the page while the exit lookup runs, so the first navigation no longer waits for the proxy's CONNECT after Chrome launches.
- 6fdc44d: Make the README focus on installation and everyday usage, preserve the detailed API reference in linked docs, and refresh runnable examples for common workflows with explicit client cleanup.

## 0.1.0

### Minor Changes

- 671ef0c: First experimental release for Linux x64: install the library archive and run it with the matching Xrio Chromium download. Requires Node.js 24 or newer.
