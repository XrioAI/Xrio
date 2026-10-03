import { describe, expectTypeOf, it } from "vite-plus/test";

import type { BrowserInputs } from "./inputs.ts";

describe("BrowserInputs types", () => {
  it("is not satisfied by a hand-built object, so only mergeBrowserInputs mints it", () => {
    expectTypeOf<{
      switches: readonly string[];
      environment: Readonly<Record<string, string>>;
      forwardedEnvironment: Readonly<Record<string, string>>;
      preferences: Readonly<Record<string, never>>;
      localState: Readonly<Record<string, never>>;
    }>().not.toExtend<BrowserInputs>();
  });
});
