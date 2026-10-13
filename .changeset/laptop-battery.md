---
"@xrio/core": minor
---

A browser that presents a laptop GL persona over SwiftShader on a fork listing the `battery-status` knob now presents a battery drawn from its seed, full and plugged in, discharging or charging, sent as `--xrio-battery-status` and reported as `identity.surfaces.battery`, with a `battery-drift` tell and a note when the page shows another battery; native GPUs, desktops, stock Chrome and forks without the knob keep Chrome's own battery and report `{ source: "host" }`. The `form-factor-battery-skew` tell is removed, because a plugged-in, full laptop reads the same as a machine with no battery.
