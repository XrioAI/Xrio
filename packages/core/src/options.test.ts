import { inspect } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { resolveClientOptions, resolveScrapeOptions } from "./options.ts";

const page = { format: "html", url: "https://example.com" } as const;

const missingBrowserPath = {
  code: "INVALID_OPTIONS",
  message: "browserPath is required for headed mode.",
  name: "TypeError",
};

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
      const defaults = resolveClientOptions({ mode: "http" });

      expect(() =>
        // @ts-expect-error JavaScript callers can supply unsupported formats.
        resolveScrapeOptions({ format, url: "https://example.com" }, defaults),
      ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS", name: "TypeError" }));
    },
  );

  it("defaults to headed mode, which needs a browserPath", () => {
    expect(resolveClientOptions({ browserPath: "/browser" }).mode).toStrictEqual({
      browserPath: "/browser",
      mode: "headed",
    });

    expect(() => resolveClientOptions()).toThrow(expect.objectContaining(missingBrowserPath));
    // @ts-expect-error JavaScript callers can omit the browser path.
    expect(() => resolveClientOptions({})).toThrow(expect.objectContaining(missingBrowserPath));
  });

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
    expect(resolveClientOptions({ mode: "http", proxy }).proxy).toStrictEqual({
      ...expected,
      credentials: undefined,
      redactedUrl: new URL(proxy).href,
    });
  });

  it("percent-decodes credentials exactly once and redacts them", () => {
    const { proxy } = resolveClientOptions({
      mode: "http",
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
    expect(() => resolveClientOptions({ mode: "http", proxy })).toThrow(
      expect.objectContaining({ code: "INVALID_OPTIONS", name: "TypeError" }),
    );
    expect(inspectedFailure(() => resolveClientOptions({ mode: "http", proxy }))).not.toContain(
      "secret",
    );
  });

  it.each([
    { expected: "xn--bcher-kva.de", proxy: "socks5://bücher.de:1080" },
    { expected: "127.0.0.1", proxy: "socks5h://0x7f.1:1080" },
    { expected: "example.com", proxy: "socks5://ex%41mple.com:1080" },
  ])("normalises the SOCKS host $proxy as a browser would", ({ expected, proxy }) => {
    expect(resolveClientOptions({ mode: "http", proxy }).proxy?.hostname).toBe(expected);
  });

  it("uses the client default unless a scrape overrides it", () => {
    const defaults = resolveClientOptions({ mode: "http", proxy: "http://default.test:8000" });

    expect(resolveScrapeOptions(page, defaults).source.proxy?.hostname).toBe("default.test");
    expect(
      resolveScrapeOptions({ ...page, proxy: "socks5://override.test:1080" }, defaults).source.proxy
        ?.hostname,
    ).toBe("override.test");
    expect(
      resolveScrapeOptions(page, resolveClientOptions({ mode: "http" })).source.proxy,
    ).toBeUndefined();
  });

  it("refuses a proxy in browser modes until the browser relay exists", () => {
    const browser = resolveClientOptions({ browserPath: "/browser", mode: "headless" });

    expect(() =>
      resolveScrapeOptions({ ...page, proxy: "http://user:secret@proxy.test:8000" }, browser),
    ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS", name: "TypeError" }));
    expect(
      inspectedFailure(() =>
        resolveScrapeOptions({ ...page, proxy: "http://user:secret@proxy.test:8000" }, browser),
      ),
    ).not.toContain("secret");
    expect(() =>
      resolveScrapeOptions(
        { ...page, mode: "http" },
        resolveClientOptions({ browserPath: "/browser", mode: "headed", proxy: "socks5://p.test" }),
      ),
    ).not.toThrow();
  });
});

describe("timezone option", () => {
  const browser = { browserPath: "/browser", mode: "headless" } as const;

  const invalidZone = {
    code: "INVALID_OPTIONS",
    message: "timezone must be an IANA zone name such as America/New_York.",
    name: "TypeError",
  };

  const notInHttp = {
    code: "INVALID_OPTIONS",
    message: "timezone is only supported in browser modes.",
    name: "TypeError",
  };

  it.each([
    ["UTC", "UTC"],
    ["Europe/Kyiv", "Europe/Kiev"],
    ["Asia/Kolkata", "Asia/Calcutta"],
    ["america/chicago", "America/Chicago"],
  ])("accepts %s as a client default and resolves it to %s", (timezone, zone) => {
    expect(resolveClientOptions({ ...browser, timezone }).timezone).toBe(zone);
  });

  it("defaults to no zone", () => {
    expect(resolveClientOptions(browser).timezone).toBeUndefined();
    expect(resolveClientOptions({ mode: "http" }).timezone).toBeUndefined();
    expect(resolveScrapeOptions(page, resolveClientOptions(browser)).source).toMatchObject({
      mode: "headless",
      pins: { timezone: undefined },
    });
  });

  it.each(["Mars/Olympus", "", " UTC", "Etc/Unknown", "+05:30", "-08:00", "GMT+5"])(
    "rejects the zone %j",
    (timezone) => {
      expect(() => resolveClientOptions({ ...browser, timezone })).toThrow(
        expect.objectContaining(invalidZone),
      );
      expect(() =>
        resolveScrapeOptions({ ...page, timezone }, resolveClientOptions(browser)),
      ).toThrow(expect.objectContaining(invalidZone));
    },
  );

  it.each([5, null, {}])("rejects the non-string zone %j", (timezone) => {
    // @ts-expect-error JavaScript callers can pass anything.
    expect(() => resolveClientOptions({ ...browser, timezone })).toThrow(
      expect.objectContaining(invalidZone),
    );
  });

  it("reaches every browser scrape of the client, and a scrape's own zone replaces it", () => {
    const defaults = resolveClientOptions({ ...browser, timezone: "Europe/Berlin" });

    expect(resolveScrapeOptions(page, defaults).source).toMatchObject({
      pins: { timezone: "Europe/Berlin" },
    });
    expect(
      resolveScrapeOptions({ ...page, timezone: "America/New_York" }, defaults).source,
    ).toMatchObject({ pins: { timezone: "America/New_York" } });
    expect(
      resolveScrapeOptions({ ...page, browserPath: "/other", mode: "headed" }, defaults).source,
    ).toMatchObject({ mode: "headed", pins: { timezone: "Europe/Berlin" } });
    expect(resolveClientOptions({ ...browser, timezone: "Europe/Berlin" }).timezone).toBe(
      "Europe/Berlin",
    );
  });

  it("gives an http scrape no zone, even when the client has one", () => {
    const defaults = resolveClientOptions({ ...browser, timezone: "Europe/Berlin" });

    expect(resolveScrapeOptions({ ...page, mode: "http" }, defaults).source).toMatchObject({
      pins: { timezone: undefined },
    });
  });

  it("gives a browser override of an http client a zone of its own", () => {
    const defaults = resolveClientOptions({ mode: "http" });

    expect(
      resolveScrapeOptions(
        { ...page, browserPath: "/browser", mode: "headless", timezone: "Asia/Kolkata" },
        defaults,
      ).source,
    ).toMatchObject({ mode: "headless", pins: { timezone: "Asia/Calcutta" } });
  });

  it("refuses a zone in an inherited http mode", () => {
    expect(() =>
      resolveScrapeOptions({ ...page, timezone: "UTC" }, resolveClientOptions({ mode: "http" })),
    ).toThrow(expect.objectContaining(notInHttp));
  });

  it("refuses a zone beside an explicit http mode, even from an options object the types did not check", () => {
    const defaults = resolveClientOptions(browser);
    const explicit = { ...page, mode: "http", timezone: "UTC" } as const;

    // @ts-expect-error JavaScript callers can pass a zone with mode http.
    expect(() => resolveScrapeOptions(explicit, defaults)).toThrow(
      expect.objectContaining(notInHttp),
    );
  });

  it("refuses a zone on an http client", () => {
    // @ts-expect-error JavaScript callers can pass a zone to an http client.
    expect(() => resolveClientOptions({ mode: "http", timezone: "UTC" })).toThrow(
      expect.objectContaining(notInHttp),
    );
  });
});

describe("browserArgs option", () => {
  const browser = { browserPath: "/browser", mode: "headless" } as const;

  it("keeps the client's switches in order, as a frozen copy the caller cannot change", () => {
    const browserArgs = [
      "--no-sandbox",
      "--disable-gpu-compositing",
      "--disk-cache-dir=/tmp/cache dir",
    ];

    const defaults = resolveClientOptions({ ...browser, browserArgs });

    browserArgs.push("--lang=fr");

    expect(defaults.browserArgs).toStrictEqual([
      "--no-sandbox",
      "--disable-gpu-compositing",
      "--disk-cache-dir=/tmp/cache dir",
    ]);
    expect(Object.isFrozen(defaults.browserArgs)).toBeTruthy();
  });

  it("defaults to no switches", () => {
    expect(resolveClientOptions(browser).browserArgs).toStrictEqual([]);
    expect(resolveClientOptions({ mode: "http" }).browserArgs).toStrictEqual([]);
  });

  it("reaches every browser scrape of the client, whatever mode it overrides to", () => {
    const defaults = resolveClientOptions({ ...browser, browserArgs: ["--no-sandbox"] });

    const headed = resolveScrapeOptions(
      { ...page, browserPath: "/other", mode: "headed" },
      defaults,
    );

    expect(resolveScrapeOptions(page, defaults).source).toMatchObject({
      browserArgs: ["--no-sandbox"],
      mode: "headless",
    });
    expect(headed.source).toMatchObject({ browserArgs: ["--no-sandbox"], mode: "headed" });
    expect(resolveScrapeOptions({ ...page, mode: "http" }, defaults).source).not.toHaveProperty(
      "browserArgs",
    );
  });

  it("refuses browserArgs on a scrape, even from an options object the types did not check", () => {
    const defaults = resolveClientOptions({ ...browser, browserArgs: ["--no-sandbox"] });
    const unchecked = { ...page, browserArgs: ["--no-sandbox"] };
    const absent = { ...page, browserArgs: undefined };

    expect(() => resolveScrapeOptions(unchecked, defaults)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "browserArgs is a client option.",
        name: "TypeError",
      }),
    );
    expect(() => resolveScrapeOptions(absent, defaults)).not.toThrow();
  });

  it("gives a browser override of an http client no switches", () => {
    const defaults = resolveClientOptions({ mode: "http" });

    expect(
      resolveScrapeOptions({ ...page, browserPath: "/browser", mode: "headless" }, defaults).source,
    ).toMatchObject({ browserArgs: [], mode: "headless" });
  });

  it.each([
    { browserArgs: [], mode: "http" },
    { browserArgs: ["--no-sandbox"], mode: "http" },
  ])("refuses $browserArgs in http mode", (options) => {
    // @ts-expect-error JavaScript callers can pass browserArgs to an http client.
    expect(() => resolveClientOptions(options)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "browserArgs is only supported in browser modes.",
        name: "TypeError",
      }),
    );
  });

  it.each([
    { entry: 1, value: ["--ok", 42] },
    { entry: 0, value: [""] },
    { entry: 0, value: ["no-sandbox"] },
    { entry: 0, value: ["-no-sandbox"] },
    { entry: 0, value: ["--"] },
    { entry: 0, value: ["--=1"] },
    { entry: 0, value: ["---x"] },
    { entry: 0, value: ["--two words"] },
    { entry: 0, value: ["--ok\0"] },
    { entry: 1, value: ["--ok", "secret"] },
    { entry: 1, value: ["--ok", undefined] },
  ])("rejects the malformed entry in $value and names only its position", ({ entry, value }) => {
    const refusal = {
      code: "INVALID_OPTIONS",
      message: `browserArgs entry ${entry} must be a switch such as --name or --name=value.`,
      name: "TypeError",
    };

    // @ts-expect-error JavaScript callers can pass anything.
    expect(() => resolveClientOptions({ ...browser, browserArgs: value })).toThrow(
      expect.objectContaining(refusal),
    );
  });

  it.each([
    "--lang=fr",
    "--lang",
    "--accept-lang=de",
    "--use-gl=egl",
    "--use-angle=metal",
    "--window-size=1,1",
    "--screen-info={0,0 1x1}",
    "--pxr-seed=1",
    "--xrio-gl-persona=x",
    "--enable-features=X",
    "--disable-features=X",
    "--user-data-dir=/tmp/x",
    "--headless",
    "--headless=new",
    "--proxy-server=http://user:secret@proxy.test:8000",
    "--remote-debugging-pipe",
    "--crash-dumps-dir=/tmp/x",
    "--disable-blink-features=AutomationControlled",
    "--profile-directory=Other",
    "--proxy-pac-url=http://user:secret@proxy.test:8000/proxy.pac",
    "--proxy-auto-detect",
    "--proxy-bypass-list=*",
    "--no-proxy-server",
    "--force-device-scale-factor=3",
    "--device-scale-factor=2",
    "--high-dpi-support=0",
    "--window-position=300,200",
    "--start-maximized",
    "--start-fullscreen",
    "--user-agent=Audit/1.0",
    "--disable-gpu",
    "--enable-unsafe-swiftshader",
    "--disable-software-rasterizer",
    "--disable-webgl",
    "--disable-3d-apis",
    "--hide-scrollbars",
    "--enable-automation",
    "--enable-blink-features=X",
    "--force-dark-mode",
    "--force-prefers-reduced-motion",
    "--touch-events=enabled",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=default_public_interface_only",
    "--enforce-webrtc-ip-permission-check",
    "--guest",
    "--incognito",
    "--kiosk",
    "--app=https://example.com",
    "--ozone-override-screen-size=800,600",
    "--force-prefers-no-reduced-motion",
    "--force-high-contrast",
    "--disable-webgl2",
    "--disable-reading-from-canvas",
    "--use-webgpu-adapter=swiftshader",
    "--enable-unsafe-webgpu",
    "--disable-webgpu",
    "--js-flags=--expose-gc",
    "--load-extension=/tmp/extension",
    "--disable-extensions-except=/tmp/extension",
    "--remote-debugging-address=0.0.0.0",
    "--remote-debugging-port=0",
    "--remote-debugging-socket-name=x",
    "--remote-allow-origins=*",
    "--disable-dev-shm-usage=1",
    "--force-color-profile",
    "--force-color-profile=srgb",
    "--enable-features=CDPScreenshotNewSurface",
  ])("refuses %s and names the switch without its value", (entry) => {
    const [name] = entry.split("=", 1);

    expect(() =>
      resolveClientOptions({ ...browser, browserArgs: ["--no-sandbox", entry] }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: `browserArgs cannot include ${name}, which Xrio manages.`,
        name: "TypeError",
      }),
    );
  });

  it("accepts a valueless switch Xrio's baseline already sets and sends it once", () => {
    const defaults = resolveClientOptions({
      ...browser,
      browserArgs: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-compositing"],
    });

    expect(defaults.browserArgs).toStrictEqual(["--no-sandbox", "--disable-gpu-compositing"]);
  });

  it("reports the first managed switch when several are refused", () => {
    expect(() =>
      resolveClientOptions({ ...browser, browserArgs: ["--lang=fr", "--user-data-dir=/tmp/x"] }),
    ).toThrow("browserArgs cannot include --lang, which Xrio manages.");
  });

  it.each(["--no-sandbox", { 0: "--no-sandbox", length: 1 }, null])(
    "rejects %j, which is not an array",
    (value) => {
      // @ts-expect-error JavaScript callers can pass anything.
      expect(() => resolveClientOptions({ ...browser, browserArgs: value })).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "browserArgs must be an array of strings.",
          name: "TypeError",
        }),
      );
    },
  );
});

describe("locale option", () => {
  const browser = { browserPath: "/browser", mode: "headless" } as const;

  const posixLocale = {
    code: "INVALID_OPTIONS",
    message:
      "locale must be a BCP 47 language tag such as de-DE, not a POSIX locale such as en_US.UTF-8.",
    name: "TypeError",
  };

  const malformedLocale = {
    code: "INVALID_OPTIONS",
    message: "locale must be one BCP 47 language tag such as de-DE.",
    name: "TypeError",
  };

  it.each([
    { given: "de-de", tag: "de-DE" },
    { given: "EN-au", tag: "en-AU" },
    { given: "pt-BR", tag: "pt-BR" },
  ])("canonicalizes $given to $tag", ({ given, tag }) => {
    expect(resolveClientOptions({ locale: given, mode: "http" }).locale).toBe(tag);
    expect(
      resolveScrapeOptions({ ...page, locale: given }, resolveClientOptions({ mode: "http" }))
        .source.pins.locale,
    ).toBe(tag);
  });

  it("leaves the locale unpinned until a caller pins one", () => {
    const defaults = resolveClientOptions(browser);

    expect(defaults.locale).toBeUndefined();
    expect(resolveScrapeOptions(page, defaults).source.pins).toStrictEqual({
      locale: undefined,
      timezone: undefined,
    });
  });

  it("applies the client default to every mode and lets a scrape override it", () => {
    const defaults = resolveClientOptions({ ...browser, locale: "ja-JP" });

    expect(resolveScrapeOptions(page, defaults).source.pins.locale).toBe("ja-JP");
    expect(resolveScrapeOptions({ ...page, mode: "http" }, defaults).source.pins.locale).toBe(
      "ja-JP",
    );
    expect(resolveScrapeOptions({ ...page, locale: "en-GB" }, defaults).source.pins.locale).toBe(
      "en-GB",
    );
    expect(resolveScrapeOptions({ ...page, locale: undefined }, defaults).source.pins.locale).toBe(
      "ja-JP",
    );
  });

  it.each(["en_US.UTF-8", "en_US", "de_DE@euro", "C.UTF-8"])(
    "refuses the POSIX form %j with the POSIX message",
    (locale) => {
      expect(() => resolveClientOptions({ locale, mode: "http" })).toThrow(
        expect.objectContaining(posixLocale),
      );
      expect(() =>
        resolveScrapeOptions({ ...page, locale }, resolveClientOptions({ mode: "http" })),
      ).toThrow(expect.objectContaining(posixLocale));
    },
  );

  it.each(["", "de-DE,fr-FR", "en-US ", " de-DE", "C", "de-"])(
    "refuses the malformed form %j with the BCP 47 message",
    (locale) => {
      expect(() => resolveClientOptions({ locale, mode: "http" })).toThrow(
        expect.objectContaining(malformedLocale),
      );
      expect(() =>
        resolveScrapeOptions({ ...page, locale }, resolveClientOptions({ mode: "http" })),
      ).toThrow(expect.objectContaining(malformedLocale));
    },
  );

  it.each([
    {
      locale: "de",
      message:
        "locale de is not one Xrio has measured Chrome's language list for. Try de-AT, de-CH, or de-DE.",
    },
    {
      locale: "ja-JP-u-ca-japanese",
      message:
        "locale ja-JP-u-ca-japanese is not one Xrio has measured Chrome's language list for. Try ja-JP.",
    },
    {
      locale: "zh-Hant-TW",
      message:
        "locale zh-Hant-TW is not one Xrio has measured Chrome's language list for. Try zh-CN, zh-HK, or zh-TW.",
    },
    {
      locale: "sw-KE",
      message: "locale sw-KE is not one Xrio has measured Chrome's language list for.",
    },
  ])(
    "refuses the unmeasured tag $locale and names the measured tags of its language",
    (refusal) => {
      expect(() => resolveClientOptions({ locale: refusal.locale, mode: "http" })).toThrow(
        expect.objectContaining({ code: "INVALID_OPTIONS", message: refusal.message }),
      );
    },
  );
});
