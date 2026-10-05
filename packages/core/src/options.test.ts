import { inspect } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { resolveClientOptions, resolveScrapeOptions } from "./options.ts";

const page = { format: "html", url: "https://example.com" } as const;

describe("scrape options", () => {
  it("inherits the complete client mode unless the call supplies its own", () => {
    const defaults = resolveClientOptions({ browserPath: "/client-browser", mode: "headed" });
    const inherited = resolveScrapeOptions(page, defaults);
    const overridden = resolveScrapeOptions({ ...page, mode: "http" }, defaults);

    expect(inherited).toMatchObject({
      source: { browserPath: "/client-browser", mode: "headed" },
      timeoutMs: 60_000,
    });
    expect(overridden.source.mode).toBe("http");
    expect(overridden.source).not.toHaveProperty("browserPath");

    // @ts-expect-error JavaScript callers can bypass the required override path.
    expect(() => resolveScrapeOptions({ ...page, mode: "headless" }, defaults)).toThrow(
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
        resolveScrapeOptions({ format, url: "https://example.com" }, resolveClientOptions({})),
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

const inspectedFailure = (run: () => object): string => {
  try {
    run();
  } catch (error) {
    return inspect(error, { depth: Number.POSITIVE_INFINITY });
  }

  return "";
};

describe("proxy option", () => {
  it.each([
    {
      expected: { hostname: "proxy.test", port: 80, protocol: "http" },
      proxy: "http://proxy.test",
    },
    {
      expected: { hostname: "proxy.test", port: 443, protocol: "https" },
      proxy: "https://proxy.test/",
    },
    {
      expected: { hostname: "proxy.test", port: 1080, protocol: "socks5" },
      proxy: "socks5://proxy.test",
    },
    {
      expected: { hostname: "proxy.test", port: 9050, protocol: "socks5" },
      proxy: "SOCKS5H://proxy.test:9050",
    },
    { expected: { hostname: "[::1]", port: 8000, protocol: "http" }, proxy: "http://[::1]:8000" },
  ])("parses $proxy", ({ expected, proxy }) => {
    expect(resolveClientOptions({ proxy }).proxy).toStrictEqual({
      ...expected,
      credentials: undefined,
      redactedUrl: new URL(proxy).href,
    });
  });

  it("percent-decodes credentials exactly once and redacts them", () => {
    const { proxy } = resolveClientOptions({
      proxy: "http://us%3Aer:p%2540ss%20word@proxy.test:8000",
    });

    expect(proxy).toMatchObject({
      credentials: { password: "p%40ss word", username: "us:er" },
      redactedUrl: "http://proxy.test:8000/",
    });
  });

  it.each([
    "proxy.test:8000",
    "ftp://user:secret@proxy.test",
    "http://user:secret@proxy.test:8000/path",
    "http://user:secret@proxy.test:8000/?query",
    "http://user:secret@proxy.test:8000/#hash",
    "socks5://user:secret%zz@proxy.test:1080",
    "user:secret@proxy.test:8000",
    "proxy.test:8000:user:secret",
    "socks5:user:secret@proxy.test:1080",
    "socks5:///user:secret@proxy.test:1080",
  ])("rejects %s without echoing credentials anywhere in the error", (proxy) => {
    expect(() => resolveClientOptions({ proxy })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTIONS", name: "TypeError" }),
    );
    expect(inspectedFailure(() => resolveClientOptions({ proxy }))).not.toContain("secret");
  });

  it.each([
    { expected: "xn--bcher-kva.de", proxy: "socks5://bücher.de:1080" },
    { expected: "127.0.0.1", proxy: "socks5h://0x7f.1:1080" },
    { expected: "example.com", proxy: "socks5://ex%41mple.com:1080" },
  ])("normalises the SOCKS host $proxy as a browser would", ({ expected, proxy }) => {
    expect(resolveClientOptions({ proxy }).proxy?.hostname).toBe(expected);
  });

  it("uses the client default unless a scrape overrides it", () => {
    const defaults = resolveClientOptions({ proxy: "http://default.test:8000" });

    expect(resolveScrapeOptions(page, defaults).source.proxy?.hostname).toBe("default.test");
    expect(
      resolveScrapeOptions({ ...page, proxy: "socks5://override.test:1080" }, defaults).source.proxy
        ?.hostname,
    ).toBe("override.test");
    expect(resolveScrapeOptions(page, resolveClientOptions({})).source.proxy).toBeUndefined();
  });
});
