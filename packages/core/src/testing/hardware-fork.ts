import type { HostCapabilities, KnobRegistry } from "../humanizer/contracts.ts";
import { NOISE_KNOBS } from "./noise-fork.ts";

export const HARDWARE_KNOBS: KnobRegistry = {
  "device-memory": { origin: "def", value: null },
  "hardware-concurrency": { origin: "def", value: null },
  "spoof-hardware": { origin: "def", value: "true" },
};

export const HARDWARE_AND_NOISE_KNOBS: KnobRegistry = { ...HARDWARE_KNOBS, ...NOISE_KNOBS };

export const forkWithKnobs = (
  knobs: KnobRegistry = HARDWARE_AND_NOISE_KNOBS,
  permittedCpus = 32,
): HostCapabilities => ({
  fork: {
    buildUnreadable: false,
    commit: null,
    dialect: "xrio",
    dirty: null,
    knobs,
    packageDir: "/opt/xrio-chrome",
    personas: { gl: [], refusedGl: [], speech: [] },
    version: "154.0.8037.57",
  },
  permittedCpus,
  platform: "linux",
});
