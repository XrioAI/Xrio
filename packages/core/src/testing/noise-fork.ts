import type { KnobRegistry } from "../humanizer/contracts.ts";

export const NOISE_KNOBS: KnobRegistry = {
  "perturb-audio": { origin: "def", value: "false" },
  "perturb-canvas": { origin: "def", value: "false" },
  seed: { origin: "def", value: null },
};
