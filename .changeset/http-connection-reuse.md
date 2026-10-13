---
"@xrio/core": minor
---

An http scrape whose exit cannot change, a direct route or a `config.proxy.url` with a `{session}` placeholder, now reuses the connections an earlier scrape of the same client left open for up to 30 s, so a repeat scrape of an origin skips the TCP, proxy CONNECT and TLS handshakes; scrapes through an explicit `proxy` still connect afresh.
