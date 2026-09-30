import { describe, expect, it } from "vite-plus/test";

import { resolveOptions } from "./config.ts";

describe(resolveOptions, () => {
  it("defaults to info-level logging that is switched on", () => {
    const { log } = resolveOptions();

    expect(log).toMatchObject({ enabled: true, level: "info" });
  });

  it("lets callers override single fields without losing the other defaults", () => {
    const { log } = resolveOptions({ log: { level: "debug" } });

    expect(log).toMatchObject({ enabled: true, level: "debug" });
  });

  it("rejects an unknown log level", () => {
    // @ts-expect-error -- exercising a JavaScript caller passing a bad level
    expect(() => resolveOptions({ log: { level: "verbose" } })).toThrow(/log\.level/u);
  });
});
