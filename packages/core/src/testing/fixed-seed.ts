import type { IdentityContext } from "../humanizer/surfaces.ts";

export const fixedSeed = "9f2c41d07a3be815";

export const fixedDevice: IdentityContext["device"] = { kind: "fresh", seed: fixedSeed };

export const fixedRandom = (): Uint8Array => Buffer.from(fixedSeed, "hex");
