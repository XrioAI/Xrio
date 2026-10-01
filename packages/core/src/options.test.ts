import { describe, expect, it } from "vite-plus/test";

import { resolveClientOptions, resolveScrapeOptions } from "./options.ts";

describe("scrape options", () => {
  it("inherits the complete client mode unless the call supplies its own", () => {
    const mode = resolveClientOptions({ browserPath: "/client-browser", mode: "headed" });
    const options = { format: "html", url: "https://example.com" } as const;
    const inherited = resolveScrapeOptions(options, mode);
    const overridden = resolveScrapeOptions({ ...options, mode: "http" }, mode);

    expect(inherited).toMatchObject({
      browserPath: "/client-browser",
      mode: "headed",
      timeoutMs: 60_000,
    });
    expect(overridden.mode).toBe("http");
    expect(overridden).not.toHaveProperty("browserPath");

    // @ts-expect-error JavaScript callers can bypass the required override path.
    expect(() => resolveScrapeOptions({ ...options, mode: "headless" }, mode)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "browserPath is required for headless mode.",
        name: "TypeError",
      }),
    );
  });

  it.each(["toString", "__proto__", "pdf"])(
    "rejects an unsupported format %s before dispatch",
    (format) => {
      expect(() =>
        // @ts-expect-error JavaScript callers can supply unsupported formats.
        resolveScrapeOptions({ format, url: "https://example.com" }, { mode: "http" }),
      ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS", name: "TypeError" }));
    },
  );

  it("rejects an unsupported mode before dispatch", () => {
    // @ts-expect-error JavaScript callers can supply unsupported modes.
    expect(() => resolveClientOptions({ mode: "toString" })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTIONS", name: "TypeError" }),
    );
  });
});
