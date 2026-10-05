import type { HostCapabilities, KnobRegistry } from "../humanizer/contracts.ts";

export const HARDWARE_KNOBS: KnobRegistry = {
  "device-memory": { origin: "def", value: null },
  "hardware-concurrency": { origin: "def", value: null },
  "spoof-hardware": { origin: "def", value: "true" },
};

export const forkWithKnobs = (
  knobs: KnobRegistry = HARDWARE_KNOBS,
  permittedCpus = 32,
): HostCapabilities => ({
  fork: {
    buildUnreadable: false,
    commit: null,
    dialect: "xrio",
    dirty: null,
    knobs,
    packageDir: "/opt/xrio-chrome",
    personas: { speech: [] },
    version: "154.0.8037.57",
  },
  permittedCpus,
  platform: "linux",
});
