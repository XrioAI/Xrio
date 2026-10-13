---
"@xrio/core": patch
---

A proxied browser scrape of an https page now opens its tunnel to the page while the exit lookup runs, so the first navigation no longer waits for the proxy's CONNECT after Chrome launches.
