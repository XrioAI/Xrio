---
"@xrio/core": minor
---

`identity.observed.batteryState` now also holds the page's `chargingTime` and `dischargingTime` from `getBattery()`, with `null` for a time Chrome reports as `Infinity`.
