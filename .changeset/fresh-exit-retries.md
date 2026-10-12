---
"@xrio/core": minor
---

Retry a page that reads `blocked` in an anonymous scrape on a new proxy session with a new device when `scrape.retries` allows it and the scrape routes through a `config.proxy.url` with a `{session}` placeholder.
