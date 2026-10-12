---
"@xrio/core": minor
---

Browsers that render on SwiftShader now turn on the Xrio fork's seeded canvas and audio noise, with a fork seed drawn from each identity's seed, and report it as `identity.surfaces.noise`; stock Chrome and forks without the noise knobs carry the `noise-unhonored` tell. `host.noise` in `xrio.config` (`auto`, `on` or `off`) forces it either way.
