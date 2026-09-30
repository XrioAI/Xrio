import { describe, expect, it } from "vite-plus/test";

import { resolveOptions } from "./config.ts";

describe(resolveOptions, () => {
  it("defaults to no HTTP server, docs on, and info-level logging", () => {
    const { http, log } = resolveOptions();

    expect(http).toStrictEqual({ docs: true, enabled: false, host: "127.0.0.1", port: 3000 });
    expect(log).toMatchObject({ enabled: true, level: "info" });
  });

  it("lets callers override single fields without losing the other defaults", () => {
    const { http, log } = resolveOptions({
      http: { enabled: true, port: 8080 },
      log: { level: "debug" },
    });

    expect(http).toStrictEqual({ docs: true, enabled: true, host: "127.0.0.1", port: 8080 });
    expect(log).toMatchObject({ enabled: true, level: "debug" });
  });

  it("rejects ports that cannot work", () => {
    expect(() => resolveOptions({ http: { port: 70_000 } })).toThrow(/http\.port/u);
    expect(() => resolveOptions({ http: { port: 1.5 } })).toThrow(/http\.port/u);
    expect(() => resolveOptions({ http: { port: -1 } })).toThrow(/http\.port/u);
  });

  it("rejects an unknown log level", () => {
    // @ts-expect-error -- exercising a JavaScript caller passing a bad level
    expect(() => resolveOptions({ log: { level: "verbose" } })).toThrow(/log\.level/u);
  });
});
