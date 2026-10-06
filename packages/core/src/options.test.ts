import { homedir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import type { DeviceRecord } from "./humanizer/contracts.ts";
import { refuseRecordOverrides, resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { noPins } from "./testing/no-pins.ts";
import type { HardwareOptions, ScrapeOptions } from "./types.ts";

const page = { format: "html", url: "https://example.com" } as const;

const missingBrowserPath = {
  code: "INVALID_OPTIONS",
  message: "browserPath is required for headed mode.",
  name: "TypeError",
};

describe("scrape options", () => {
  it("inherits the complete client mode unless the call supplies its own", () => {
    const defaults = resolveClientOptions({ browserPath: "/client-browser", mode: "headed" });
    const inherited = resolveScrapeIntent(page, defaults);
    const overridden = resolveScrapeIntent({ ...page, mode: "http" }, defaults);

    expect(inherited).toMatchObject({
      source: { browserPath: "/client-browser", mode: "headed" },
      timeoutMs: 60_000,
    });
    expect(overridden.source.mode).toBe("http");
    expect(overridden.source).not.toHaveProperty("browserPath");

    // @ts-expect-error JavaScript callers can bypass the required override path.
    expect(() => resolveScrapeIntent({ ...page, mode: "headless" }, defaults)).toThrow(
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
        resolveScrapeIntent({ format, url: "https://example.com" }, defaults),
      ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS", name: "TypeError" }));
    },
  );

  it("defaults to headed mode, which needs a browserPath", () => {
    expect(resolveClientOptions({ browserPath: "/browser" }).mode).toBe("headed");

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
    expect(resolveClientOptions({ mode: "http", proxy }).route).toStrictEqual({
      ...expected,
      credentials: undefined,
      redactedUrl: new URL(proxy).href,
    });
  });

  it("percent-decodes credentials exactly once and redacts them", () => {
    const { route: proxy } = resolveClientOptions({
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
    expect(resolveClientOptions({ mode: "http", proxy }).route?.hostname).toBe(expected);
  });

  it("uses the client default unless a scrape overrides it", () => {
    const defaults = resolveClientOptions({ mode: "http", proxy: "http://default.test:8000" });

    expect(resolveScrapeIntent(page, defaults).route?.hostname).toBe("default.test");
    expect(
      resolveScrapeIntent({ ...page, proxy: "socks5://override.test:1080" }, defaults).route
        ?.hostname,
    ).toBe("override.test");
    expect(resolveScrapeIntent(page, resolveClientOptions({ mode: "http" })).route).toBeUndefined();
  });

  it("keeps a browser-mode scrape's proxy as its route and leaves the password out of its URL", () => {
    const browser = resolveClientOptions({ browserPath: "/browser", mode: "headless" });

    const { route } = resolveScrapeIntent(
      { ...page, proxy: "http://user:secret@proxy.test:8000" },
      browser,
    );

    expect(route?.hostname).toBe("proxy.test");
    expect(route?.redactedUrl).toBe("http://proxy.test:8000/");
    expect(route?.credentials).toStrictEqual({ password: "secret", username: "user" });
    expect(
      resolveScrapeIntent(
        page,
        resolveClientOptions({ browserPath: "/browser", mode: "headed", proxy: "socks5://p.test" }),
      ).route?.hostname,
    ).toBe("p.test");
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
    expect(resolveClientOptions({ ...browser, timezone }).identity.timezone).toBe(zone);
  });

  it("defaults to no zone", () => {
    expect(resolveClientOptions(browser).identity.timezone).toBeUndefined();
    expect(resolveClientOptions({ mode: "http" }).identity.timezone).toBeUndefined();
    expect(resolveScrapeIntent(page, resolveClientOptions(browser))).toMatchObject({
      identity: { timezone: undefined },
      source: { mode: "headless" },
    });
  });

  it.each(["Mars/Olympus", "", " UTC", "Etc/Unknown", "+05:30", "-08:00", "GMT+5"])(
    "rejects the zone %j",
    (timezone) => {
      expect(() => resolveClientOptions({ ...browser, timezone })).toThrow(
        expect.objectContaining(invalidZone),
      );
      expect(() =>
        resolveScrapeIntent({ ...page, timezone }, resolveClientOptions(browser)),
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

    expect(resolveScrapeIntent(page, defaults)).toMatchObject({
      identity: { timezone: "Europe/Berlin" },
    });
    expect(resolveScrapeIntent({ ...page, timezone: "America/New_York" }, defaults)).toMatchObject({
      identity: { timezone: "America/New_York" },
    });
    expect(
      resolveScrapeIntent({ ...page, browserPath: "/other", mode: "headed" }, defaults),
    ).toMatchObject({ identity: { timezone: "Europe/Berlin" }, source: { mode: "headed" } });
    expect(resolveClientOptions({ ...browser, timezone: "Europe/Berlin" }).identity.timezone).toBe(
      "Europe/Berlin",
    );
  });

  it("gives an http scrape no zone, even when the client has one", () => {
    const defaults = resolveClientOptions({ ...browser, timezone: "Europe/Berlin" });

    expect(resolveScrapeIntent({ ...page, mode: "http" }, defaults)).toMatchObject({
      identity: { timezone: undefined },
    });
  });

  it("gives a browser override of an http client a zone of its own", () => {
    const defaults = resolveClientOptions({ mode: "http" });

    expect(
      resolveScrapeIntent(
        { ...page, browserPath: "/browser", mode: "headless", timezone: "Asia/Kolkata" },
        defaults,
      ),
    ).toMatchObject({ identity: { timezone: "Asia/Calcutta" }, source: { mode: "headless" } });
  });

  it("refuses a zone in an inherited http mode", () => {
    expect(() =>
      resolveScrapeIntent({ ...page, timezone: "UTC" }, resolveClientOptions({ mode: "http" })),
    ).toThrow(expect.objectContaining(notInHttp));
  });

  it("refuses a zone beside an explicit http mode, even from an options object the types did not check", () => {
    const defaults = resolveClientOptions(browser);
    const explicit = { ...page, mode: "http", timezone: "UTC" } as const;

    // @ts-expect-error JavaScript callers can pass a zone with mode http.
    expect(() => resolveScrapeIntent(explicit, defaults)).toThrow(
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

    expect(defaults.browser.browserArgs).toStrictEqual([
      "--no-sandbox",
      "--disable-gpu-compositing",
      "--disk-cache-dir=/tmp/cache dir",
    ]);
    expect(Object.isFrozen(defaults.browser.browserArgs)).toBeTruthy();
  });

  it("defaults to no switches", () => {
    expect(resolveClientOptions(browser).browser.browserArgs).toStrictEqual([]);
    expect(resolveClientOptions({ mode: "http" }).browser.browserArgs).toStrictEqual([]);
  });

  it("reaches every browser scrape of the client, whatever mode it overrides to", () => {
    const defaults = resolveClientOptions({ ...browser, browserArgs: ["--no-sandbox"] });

    const headed = resolveScrapeIntent(
      { ...page, browserPath: "/other", mode: "headed" },
      defaults,
    );

    expect(resolveScrapeIntent(page, defaults).source).toMatchObject({
      browserArgs: ["--no-sandbox"],
      mode: "headless",
    });
    expect(headed.source).toMatchObject({ browserArgs: ["--no-sandbox"], mode: "headed" });
    expect(resolveScrapeIntent({ ...page, mode: "http" }, defaults).source).not.toHaveProperty(
      "browserArgs",
    );
  });

  it("refuses browserArgs on a scrape, even from an options object the types did not check", () => {
    const defaults = resolveClientOptions({ ...browser, browserArgs: ["--no-sandbox"] });
    const unchecked = { ...page, browserArgs: ["--no-sandbox"] };
    const absent = { ...page, browserArgs: undefined };

    expect(() => resolveScrapeIntent(unchecked, defaults)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "browserArgs is a client option.",
        name: "TypeError",
      }),
    );
    expect(() => resolveScrapeIntent(absent, defaults)).not.toThrow();
  });

  it("gives a browser override of an http client no switches", () => {
    const defaults = resolveClientOptions({ mode: "http" });

    expect(
      resolveScrapeIntent({ ...page, browserPath: "/browser", mode: "headless" }, defaults).source,
    ).toMatchObject({ browserArgs: [], mode: "headless" });
  });

  it("keeps an http client's browser defaults for the browser scrapes it inherits them in", () => {
    const defaults = resolveClientOptions({
      browserArgs: ["--no-sandbox"],
      browserPath: "/browser",
      mode: "http",
    });

    expect(resolveScrapeIntent(page, defaults).source).toStrictEqual({ mode: "http" });
    expect(defaults.browser).toStrictEqual({
      browserArgs: ["--no-sandbox"],
      browserPath: "/browser",
    });
    expect(
      resolveScrapeIntent({ ...page, browserPath: "/other", mode: "headless" }, defaults).source,
    ).toStrictEqual({ browserArgs: ["--no-sandbox"], browserPath: "/other", mode: "headless" });
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
    "--xrio-hardware-concurrency=8",
    "--xrio-device-memory=16",
    "--xrio-spoof-hardware=false",
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
    "--test-type",
    "--test-type=webdriver",
    "--test-type=gpu",
    "--disable-component-extensions-with-background-pages",
    "--disable-component-extensions-with-background-pages=1",
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

    expect(defaults.browser.browserArgs).toStrictEqual([
      "--no-sandbox",
      "--disable-gpu-compositing",
    ]);
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
    expect(resolveClientOptions({ locale: given, mode: "http" }).identity.locale).toBe(tag);
    expect(
      resolveScrapeIntent({ ...page, locale: given }, resolveClientOptions({ mode: "http" }))
        .identity.locale,
    ).toBe(tag);
  });

  it("leaves the locale unpinned until a caller pins one", () => {
    const defaults = resolveClientOptions(browser);

    expect(defaults.identity.locale).toBeUndefined();
    expect(resolveScrapeIntent(page, defaults).identity).toStrictEqual({
      display: undefined,
      hardware: undefined,
      locale: undefined,
      timezone: undefined,
    });
  });

  it("applies the client default to every mode and lets a scrape override it", () => {
    const defaults = resolveClientOptions({ ...browser, locale: "ja-JP" });

    expect(resolveScrapeIntent(page, defaults).identity.locale).toBe("ja-JP");
    expect(resolveScrapeIntent({ ...page, mode: "http" }, defaults).identity.locale).toBe("ja-JP");
    expect(resolveScrapeIntent({ ...page, locale: "en-GB" }, defaults).identity.locale).toBe(
      "en-GB",
    );
    expect(resolveScrapeIntent({ ...page, locale: undefined }, defaults).identity.locale).toBe(
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
        resolveScrapeIntent({ ...page, locale }, resolveClientOptions({ mode: "http" })),
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
        resolveScrapeIntent({ ...page, locale }, resolveClientOptions({ mode: "http" })),
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

const refusal = (message: string) => ({ code: "INVALID_OPTIONS", message, name: "TypeError" });

describe("display option", () => {
  const browser = { browserPath: "/browser", mode: "headless" } as const;

  it("turns single values into one-row tables and leaves the rest to the draw", () => {
    expect(
      resolveClientOptions({
        ...browser,
        display: {
          screen: { height: 900, width: 1440 },
          taskbar: { bottom: 48 },
          window: "maximized",
        },
      }).identity.display,
    ).toStrictEqual({
      screens: [{ height: 900, weight: 1, width: 1440 }],
      taskbars: [{ bottom: 48, left: 0, right: 0, top: 0, weight: 1 }],
      windows: [{ kind: "maximized", weight: 1 }],
    });
    expect(
      resolveClientOptions({ ...browser, display: { taskbar: {} } }).identity.display,
    ).toStrictEqual({
      screens: undefined,
      taskbars: [{ bottom: 0, left: 0, right: 0, top: 0, weight: 1 }],
      windows: undefined,
    });
    expect(resolveClientOptions(browser).identity.display).toBeUndefined();
  });

  it("keeps weighted tables, sized windows and their positions", () => {
    expect(
      resolveClientOptions({
        ...browser,
        display: {
          screen: [
            { height: 1080, weight: 40, width: 1920 },
            { height: 1440, weight: 7, width: 2560 },
          ],
          taskbar: [
            { left: 64, top: 32, weight: 3 },
            { bottom: 48, weight: 2 },
          ],
          window: [
            { maximized: true, weight: 4 },
            { height: 800, weight: 1, width: 1280 },
            { height: 700, weight: 1, width: 1300, x: 100, y: 120 },
          ],
        },
      }).identity.display,
    ).toStrictEqual({
      screens: [
        { height: 1080, weight: 40, width: 1920 },
        { height: 1440, weight: 7, width: 2560 },
      ],
      taskbars: [
        { bottom: 0, left: 64, right: 0, top: 32, weight: 3 },
        { bottom: 48, left: 0, right: 0, top: 0, weight: 2 },
      ],
      windows: [
        { kind: "maximized", weight: 4 },
        { height: 800, kind: "sized", weight: 1, width: 1280 },
        { height: 700, kind: "sized", position: { x: 100, y: 120 }, weight: 1, width: 1300 },
      ],
    });
  });

  it("lets a scrape replace one field of the client's display and keeps the others", () => {
    const defaults = resolveClientOptions({
      ...browser,
      display: { screen: { height: 900, width: 1440 }, taskbar: { bottom: 48 } },
    });

    expect(
      resolveScrapeIntent({ ...page, display: { taskbar: { top: 32 } } }, defaults).identity
        .display,
    ).toStrictEqual({
      screens: [{ height: 900, weight: 1, width: 1440 }],
      taskbars: [{ bottom: 0, left: 0, right: 0, top: 32, weight: 1 }],
      windows: undefined,
    });
    expect(resolveScrapeIntent(page, defaults).identity.display).toBe(defaults.identity.display);
  });

  it.each([
    {
      display: { screen: { height: 900, width: 1440 }, window: { height: 900, width: 1440 } },
      message:
        "display window 1440x900 at 0,32 does not fit the 1440x868 work area at 0,32 of a 1440x900 screen.",
      name: "a window taller than the work area under a drawn top bar",
    },
    {
      display: {
        screen: { height: 900, width: 1440 },
        taskbar: { top: 32 },
        window: { height: 800, width: 1200, x: 300, y: 10 },
      },
      message:
        "display window 1200x800 at 300,10 does not fit the 1440x868 work area at 0,32 of a 1440x900 screen.",
      name: "a window placed over the top bar",
    },
    {
      display: { screen: { height: 900, width: 1440 }, window: { height: 600, width: 499 } },
      message:
        "display leaves a 499x600 window in the 1440x868 work area at 0,32 of a 1440x900 screen, under Chrome's 500x88 px minimum window.",
      name: "a window under Chrome's minimum width",
    },
    {
      display: { screen: { height: 600, width: 800 }, taskbar: { left: 400 } },
      message:
        "display leaves a 400x600 window in the 400x600 work area at 400,0 of a 800x600 screen, under Chrome's 500x88 px minimum window.",
      name: "a taskbar that leaves a maximized window under the minimum",
    },
    {
      display: {
        screen: { height: 900, width: 1440 },
        taskbar: {},
        window: { height: 50, width: 600, x: 0, y: 0 },
      },
      message:
        "display leaves a 600x50 window in the 1440x900 work area at 0,0 of a 1440x900 screen, under Chrome's 500x88 px minimum window.",
      name: "a window shorter than Chrome's minimum height",
    },
    {
      display: { screen: { height: 900, width: 1440 }, taskbar: { top: 820 }, window: "maximized" },
      message:
        "display leaves a 1440x80 window in the 1440x80 work area at 0,820 of a 1440x900 screen, under Chrome's 500x88 px minimum window.",
      name: "a taskbar that leaves a maximized window under the minimum height",
    },
    {
      display: { window: { height: 1000, width: 1700 } },
      message:
        "display window 1700x1000 at 0,32 does not fit the 1366x736 work area at 0,32 of a 1366x768 screen.",
      name: "a window that does not fit one of Xrio's screens",
    },
  ] as const)("refuses $name", ({ display, message }) => {
    expect(() => resolveClientOptions({ ...browser, display })).toThrow(
      expect.objectContaining(refusal(message)),
    );
  });

  it("accepts a window at exactly Chrome's 500x88 px minimum", () => {
    expect(
      resolveClientOptions({
        ...browser,
        display: {
          screen: { height: 900, width: 1440 },
          taskbar: {},
          window: { height: 88, width: 500 },
        },
      }).identity.display?.windows,
    ).toStrictEqual([{ height: 88, kind: "sized", weight: 1, width: 500 }]);
  });

  it("checks a scrape's display against the client's fields it keeps", () => {
    const defaults = resolveClientOptions({
      ...browser,
      display: { screen: { height: 768, width: 1366 } },
    });

    expect(() =>
      resolveScrapeIntent({ ...page, display: { window: { height: 900, width: 1600 } } }, defaults),
    ).toThrow(
      expect.objectContaining(
        refusal(
          "display window 1600x900 at 0,32 does not fit the 1366x736 work area at 0,32 of a 1366x768 screen.",
        ),
      ),
    );
  });

  it.each([
    {
      display: { screen: { height: 900, width: 0 } },
      message:
        "display.screen takes a width and a height in whole pixels, such as { width: 1440, height: 900 }.",
    },
    {
      display: { screen: { height: 900.5, width: 1440 } },
      message:
        "display.screen takes a width and a height in whole pixels, such as { width: 1440, height: 900 }.",
    },
    {
      display: { screen: [] },
      message: "display.screen must be a value or a non-empty weighted table.",
    },
    {
      display: { screen: [{ height: 900, weight: 0, width: 1440 }] },
      message: "display.screen weights must be positive numbers.",
    },
    {
      display: { taskbar: { bottom: -1 } },
      message:
        "display.taskbar takes top, right, bottom and left insets in whole pixels, such as { bottom: 48 }.",
    },
    {
      display: { screen: { dpr: 2, height: 900, width: 1440 } },
      message:
        "display.screen takes a width and a height in whole pixels, such as { width: 1440, height: 900 }.",
    },
    {
      display: { window: { height: 800, left: 10, width: 1200 } },
      message:
        "display.window takes a width and a height in whole pixels, with an optional x and y.",
    },
    {
      display: { taskbar: { height: 40 } },
      message:
        "display.taskbar takes top, right, bottom and left insets in whole pixels, such as { bottom: 48 }.",
    },
    {
      display: { window: { height: 800, width: 1200, x: 10 } },
      message: "display.window x and y must be given together, as whole pixels.",
    },
    {
      display: { window: "fullscreen" },
      message: "display.window must be a value or a non-empty weighted table.",
    },
    { display: { dpr: 2 }, message: "display takes screen, taskbar and window." },
    {
      display: { window: [{ height: 600, maximized: true, weight: 1, width: 900 }] },
      message:
        "display.window rows that maximize take only { maximized: true, weight }, with no size.",
    },
    {
      display: { window: [{ maximized: true, typo: 1, weight: 1 }] },
      message:
        "display.window rows that maximize take only { maximized: true, weight }, with no size.",
    },
    {
      display: { window: [{ maximized: "no", weight: 1 }] },
      message:
        "display.window rows that maximize take only { maximized: true, weight }, with no size.",
    },
    {
      display: {
        screen: [
          { height: 1080, weight: 1e308, width: 1920 },
          { height: 900, weight: 1e308, width: 1440 },
        ],
      },
      message: "display.screen weights must add up to a finite number.",
    },
    { display: null, message: "display takes screen, taskbar and window." },
  ])("refuses the malformed display $display", ({ display, message }) => {
    // @ts-expect-error JavaScript callers can pass anything.
    expect(() => resolveClientOptions({ ...browser, display })).toThrow(
      expect.objectContaining(refusal(message)),
    );
  });

  it("is only for browser modes", () => {
    const notInHttp = refusal("display is only supported in browser modes.");

    // @ts-expect-error display needs a browser mode.
    expect(() => resolveClientOptions({ display: { window: "maximized" }, mode: "http" })).toThrow(
      expect.objectContaining(notInHttp),
    );
    expect(() =>
      resolveScrapeIntent(
        { ...page, display: { window: "maximized" } },
        resolveClientOptions({ mode: "http" }),
      ),
    ).toThrow(expect.objectContaining(notInHttp));
    expect(
      resolveScrapeIntent(
        { ...page, mode: "http" },
        resolveClientOptions({ ...browser, display: { window: "maximized" } }),
      ).identity.display,
    ).toBeUndefined();
  });
});

describe("hardware option", () => {
  const browser = { browserPath: "/browser", mode: "headless" } as const;

  it("turns single values into one-row tables and leaves the rest to the draw", () => {
    expect(
      resolveClientOptions({ ...browser, hardware: { cores: 8, memoryGb: 16 } }).identity.hardware,
    ).toStrictEqual({
      cores: [{ value: 8, weight: 1 }],
      gpu: undefined,
      gpuPolicy: undefined,
      memoryGb: [{ value: 16, weight: 1 }],
    });
    expect(
      resolveClientOptions({ ...browser, hardware: { memoryGb: 32 } }).identity.hardware,
    ).toStrictEqual({
      cores: undefined,
      gpu: undefined,
      gpuPolicy: undefined,
      memoryGb: [{ value: 32, weight: 1 }],
    });
    expect(resolveClientOptions(browser).identity.hardware).toBeUndefined();
  });

  it("keeps weighted tables in order", () => {
    expect(
      resolveClientOptions({
        ...browser,
        hardware: {
          cores: [
            { value: 8, weight: 3 },
            { value: 12, weight: 1 },
          ],
          memoryGb: [
            { value: 8, weight: 1 },
            { value: 32, weight: 2 },
          ],
        },
      }).identity.hardware,
    ).toStrictEqual({
      cores: [
        { value: 8, weight: 3 },
        { value: 12, weight: 1 },
      ],
      gpu: undefined,
      gpuPolicy: undefined,
      memoryGb: [
        { value: 8, weight: 1 },
        { value: 32, weight: 2 },
      ],
    });
  });

  it("lets a scrape replace one field of the client's hardware and keeps the other", () => {
    const defaults = resolveClientOptions({ ...browser, hardware: { cores: 8, memoryGb: 16 } });

    expect(
      resolveScrapeIntent({ ...page, hardware: { memoryGb: 32 } }, defaults).identity.hardware,
    ).toStrictEqual({
      cores: [{ value: 8, weight: 1 }],
      gpu: undefined,
      gpuPolicy: undefined,
      memoryGb: [{ value: 32, weight: 1 }],
    });
    expect(resolveScrapeIntent(page, defaults).identity.hardware).toBe(defaults.identity.hardware);
  });

  it.each([
    { hardware: { cores: 0 }, name: "zero cores" },
    { hardware: { cores: -4 }, name: "negative cores" },
    { hardware: { cores: 6.5 }, name: "fractional cores" },
    { hardware: { cores: Number.NaN }, name: "NaN cores" },
    { hardware: { cores: Number.POSITIVE_INFINITY }, name: "infinite cores" },
    { hardware: { cores: 2_147_483_648 }, name: "more cores than the fork accepts" },
    { hardware: { cores: "8" }, name: "cores as text" },
    {
      hardware: {
        cores: [
          { value: 8, weight: 1 },
          { value: 0, weight: 1 },
        ],
      },
      name: "a zero row",
    },
  ])("refuses $name", ({ hardware }) => {
    // @ts-expect-error JavaScript callers can pass anything.
    expect(() => resolveClientOptions({ ...browser, hardware })).toThrow(
      expect.objectContaining(
        refusal(
          "hardware.cores must be a positive whole number of at most 2147483647, or a weighted table of them.",
        ),
      ),
    );
  });

  it.each([1, 3, 6, 12, 24, 64, 0, -8, 8.5, Number.NaN])("refuses %s GB of memory", (memoryGb) => {
    // @ts-expect-error JavaScript callers can pass anything.
    expect(() => resolveClientOptions({ ...browser, hardware: { memoryGb } })).toThrow(
      expect.objectContaining(
        refusal("hardware.memoryGb must be 2, 4, 8, 16 or 32 GB, or a weighted table of them."),
      ),
    );
  });

  it.each([2, 4, 8, 16, 32] as const)("accepts %s GB of memory", (memoryGb) => {
    expect(
      resolveClientOptions({ ...browser, hardware: { memoryGb } }).identity.hardware?.memoryGb,
    ).toStrictEqual([{ value: memoryGb, weight: 1 }]);
  });

  it.each([
    {
      hardware: { cores: [] },
      message: "hardware.cores must be a value or a non-empty weighted table.",
    },
    {
      hardware: { cores: [{ value: 8, weight: 0 }] },
      message: "hardware.cores weights must be positive numbers.",
    },
    {
      hardware: {
        memoryGb: [
          { value: 8, weight: 1e308 },
          { value: 16, weight: 1e308 },
        ],
      },
      message: "hardware.memoryGb weights must add up to a finite number.",
    },
    {
      hardware: { cores: [{ typo: 1, value: 8, weight: 1 }] },
      message: "hardware.cores rows take only a value and a weight.",
    },
    {
      hardware: { memoryGb: [{ typo: 1, value: 8, weight: 1 }] },
      message: "hardware.memoryGb rows take only a value and a weight.",
    },
    {
      hardware: { cores: { value: 8 } },
      message:
        "hardware.cores must be a positive whole number of at most 2147483647, or a weighted table of them.",
    },
    {
      hardware: { gpu: [] },
      message: "hardware.gpu must be a GL persona name, or a non-empty weighted table of them.",
    },
    {
      hardware: { gpu: [{ name: "basharsx4-amd-renoir", weight: 0 }] },
      message: "hardware.gpu weights must be positive numbers.",
    },
    { hardware: { threads: 8 }, message: "hardware takes cores, memoryGb, gpu and gpuPolicy." },
    { hardware: null, message: "hardware takes cores, memoryGb, gpu and gpuPolicy." },
  ])("refuses the malformed hardware $hardware", ({ hardware, message }) => {
    // @ts-expect-error JavaScript callers can pass anything.
    expect(() => resolveClientOptions({ ...browser, hardware })).toThrow(
      expect.objectContaining(refusal(message)),
    );
  });

  it("turns a GL persona name into a one-row table and keeps a weighted table in order", () => {
    expect([
      resolveClientOptions({ ...browser, hardware: { gpu: "basharsx4-amd-renoir" } }).identity
        .hardware?.gpu,
      resolveClientOptions({
        ...browser,
        hardware: {
          gpu: [
            { name: "basharsx4-swiftshader-hidden", weight: 3 },
            { name: "Synthetic_GPU.v2", weight: 1 },
          ],
        },
      }).identity.hardware?.gpu,
      resolveClientOptions({ ...browser, hardware: { gpu: "x".repeat(128) } }).identity.hardware
        ?.gpu,
    ]).toStrictEqual([
      [{ name: "basharsx4-amd-renoir", weight: 1 }],
      [
        { name: "basharsx4-swiftshader-hidden", weight: 3 },
        { name: "Synthetic_GPU.v2", weight: 1 },
      ],
      [{ name: "x".repeat(128), weight: 1 }],
    ]);
  });

  it("lets a scrape replace the client's GL persona and keeps the client's when it pins none", () => {
    const defaults = resolveClientOptions({
      ...browser,
      hardware: { cores: 8, gpu: "basharsx4-swiftshader-hidden" },
    });

    expect([
      resolveScrapeIntent({ ...page, hardware: { gpu: "basharsx4-amd-renoir" } }, defaults).identity
        .hardware,
      resolveScrapeIntent({ ...page, hardware: { cores: 12 } }, defaults).identity.hardware,
    ]).toStrictEqual([
      {
        cores: [{ value: 8, weight: 1 }],
        gpu: [{ name: "basharsx4-amd-renoir", weight: 1 }],
        gpuPolicy: undefined,
        memoryGb: undefined,
      },
      {
        cores: [{ value: 12, weight: 1 }],
        gpu: [{ name: "basharsx4-swiftshader-hidden", weight: 1 }],
        gpuPolicy: undefined,
        memoryGb: undefined,
      },
    ]);
  });

  it("takes a GPU policy as a client default and replaces it per scrape", () => {
    const defaults = resolveClientOptions({
      ...browser,
      hardware: { cores: 8, gpuPolicy: "announce" },
    });

    expect([
      defaults.identity.hardware?.gpuPolicy,
      resolveScrapeIntent({ ...page, hardware: { gpuPolicy: "matched" } }, defaults).identity
        .hardware?.gpuPolicy,
      resolveScrapeIntent({ ...page, hardware: { cores: 12 } }, defaults).identity.hardware
        ?.gpuPolicy,
      resolveScrapeIntent(
        { ...page, hardware: { gpuPolicy: "announce" } },
        resolveClientOptions(browser),
      ).identity.hardware?.gpuPolicy,
      resolveClientOptions({ ...browser, hardware: { cores: 8 } }).identity.hardware?.gpuPolicy,
    ]).toStrictEqual(["announce", "matched", "announce", "announce", undefined]);
  });

  it.each([
    { gpuPolicy: "Announce", name: "another case" },
    { gpuPolicy: "hide", name: "an unknown policy" },
    { gpuPolicy: true, name: "a boolean" },
    { gpuPolicy: null, name: "null" },
  ])("refuses a GPU policy given as $name", ({ gpuPolicy }) => {
    // @ts-expect-error JavaScript callers can pass anything.
    expect(() => resolveClientOptions({ ...browser, hardware: { gpuPolicy } })).toThrow(
      expect.objectContaining(refusal('hardware.gpuPolicy must be "matched" or "announce".')),
    );
  });

  it.each([
    { gpu: "", name: "an empty name" },
    { gpu: "x".repeat(129), name: "a name over 128 characters" },
    { gpu: ".hidden", name: "a leading dot" },
    { gpu: "..", name: "a parent reference" },
    { gpu: "personas/basharsx4", name: "a path separator" },
    { gpu: "amd renoir", name: "a space" },
    { gpu: "rénoir", name: "a letter outside A to Z" },
    { gpu: 7, name: "a number" },
    { gpu: { name: "basharsx4-amd-renoir" }, name: "a bare row" },
    {
      gpu: [{ name: "basharsx4-amd-renoir", value: 1, weight: 1 }],
      name: "a row with another field",
    },
    { gpu: [{ name: 7, weight: 1 }], name: "a row whose name is not text" },
  ])("refuses a GL persona given as $name", ({ gpu }) => {
    // @ts-expect-error JavaScript callers can pass anything.
    expect(() => resolveClientOptions({ ...browser, hardware: { gpu } })).toThrow(
      expect.objectContaining(
        refusal("hardware.gpu must be a GL persona name, or a non-empty weighted table of them."),
      ),
    );
  });

  it("is only for browser modes", () => {
    const notInHttp = refusal("hardware is only supported in browser modes.");

    // @ts-expect-error hardware needs a browser mode.
    expect(() => resolveClientOptions({ hardware: { cores: 8 }, mode: "http" })).toThrow(
      expect.objectContaining(notInHttp),
    );
    expect(() =>
      resolveScrapeIntent({ ...page, hardware: {} }, resolveClientOptions({ mode: "http" })),
    ).toThrow(expect.objectContaining(notInHttp));
    expect(
      resolveScrapeIntent(
        { ...page, mode: "http" },
        resolveClientOptions({ ...browser, hardware: { cores: 8 } }),
      ).identity.hardware,
    ).toBeUndefined();
  });
});

const HARDWARE_PINS: readonly HardwareOptions[] = [
  { cores: 8 },
  { memoryGb: 32 },
  { cores: 12, memoryGb: 8 },
];

const scrapeWith = (
  choices: Pick<ScrapeOptions, "display" | "hardware" | "locale" | "timezone">,
  mode: "headless" | "headed" = "headless",
) => {
  const { identity, source } = resolveScrapeIntent(
    { ...page, ...choices },
    resolveClientOptions({ browserPath: "/browser", mode }),
  );

  if (source.mode === "http") {
    throw new Error("A session scrape runs in a browser mode.");
  }

  return { mode: source.mode, pins: identity };
};

describe(refuseRecordOverrides, () => {
  const record: DeviceRecord = {
    device: {
      cores: 0,
      fonts: { kind: "system" },
      gpu: { backend: "swiftshader", persona: null },
      memoryGb: 0,
      screen: { height: 1080, width: 1920, workArea: { bottom: 0, left: 66, right: 0, top: 32 } },
      voices: { kind: "system" },
      window: { height: 900, kind: "floating", width: 1400, x: 200, y: 60 },
    },
    policy: { locale: "de-DE", timezone: { kind: "pinned", zone: "Europe/Berlin" } },
    schema: 1,
    seed: "9f2c41d07a3be815",
  };

  it.each([
    { name: "nothing", options: {} },
    {
      name: "the record's own locale and zone",
      options: { locale: "de-de", timezone: "europe/berlin" },
    },
    {
      name: "a display the record satisfies",
      options: {
        display: {
          screen: [
            { height: 1080, weight: 1, width: 1920 },
            { height: 1440, weight: 1, width: 2560 },
          ],
          taskbar: { left: 66, top: 32 },
          window: { height: 900, width: 1400 },
        },
      },
    },
  ])("lets a scrape that pins $name use the session", ({ options }) => {
    expect(() => {
      refuseRecordOverrides(record, scrapeWith(options));
    }).not.toThrow();
  });

  it.each([
    { fields: "locale", options: { locale: "fr-FR" } },
    { fields: "timezone", options: { timezone: "America/New_York" } },
    { fields: "display", options: { display: { screen: { height: 900, width: 1440 } } } },
    { fields: "display", options: { display: { taskbar: { bottom: 48 } } } },
    { fields: "display", options: { display: { window: "maximized" } } },
    {
      fields: "display",
      options: {
        display: {
          screen: { height: 1080, width: 1920 },
          window: { height: 900, width: 1400, x: 300, y: 40 },
        },
      },
    },
  ] as const)("refuses a scrape whose $fields conflicts with the record", ({ fields, options }) => {
    expect(() => {
      refuseRecordOverrides(record, scrapeWith(options));
    }).toThrow(
      expect.objectContaining(
        refusal(
          `The session's device record fixes its ${fields}; a scrape in that session cannot change it.`,
        ),
      ),
    );
  });

  it("lets a scrape pin the cores and memory the record presents, and refuses any others", () => {
    const presenting: DeviceRecord = {
      ...record,
      device: { ...record.device, cores: 12, memoryGb: 16 },
    };

    const fixed = `The session's device record fixes its hardware; a scrape in that session cannot change it.`;

    expect(() => {
      refuseRecordOverrides(
        presenting,
        scrapeWith({
          hardware: {
            cores: [
              { value: 8, weight: 1 },
              { value: 12, weight: 1 },
            ],
            memoryGb: 16,
          },
        }),
      );
    }).not.toThrow();

    for (const hardware of HARDWARE_PINS) {
      expect(() => {
        refuseRecordOverrides(presenting, scrapeWith({ hardware }));
      }).toThrow(expect.objectContaining(refusal(fixed)));
    }
  });

  it("lets a scrape pin any hardware on a record made where the host's own values showed", () => {
    for (const hardware of HARDWARE_PINS) {
      expect(() => {
        refuseRecordOverrides(record, scrapeWith({ hardware }));
      }).not.toThrow();
    }
  });

  it("names every field a scrape would change, the mode included", () => {
    expect(() => {
      refuseRecordOverrides(
        record,
        scrapeWith(
          { display: { window: "maximized" }, locale: "fr-FR", timezone: "UTC" },
          "headed",
        ),
      );
    }).toThrow(
      expect.objectContaining(
        refusal(
          "The session's device record fixes its mode, display, locale, and timezone; a scrape in that session cannot change them.",
        ),
      ),
    );
  });

  it("refuses a headed scrape of a headless record, and a headless scrape of a headed one", () => {
    const headed: DeviceRecord = {
      ...record,
      device: { ...record.device, window: { kind: "chrome-default" } },
    };

    expect(() => {
      refuseRecordOverrides(record, scrapeWith({}, "headed"));
    }).toThrow(
      expect.objectContaining(
        refusal(
          "The session's device record fixes its mode; a scrape in that session cannot change it.",
        ),
      ),
    );
    expect(() => {
      refuseRecordOverrides(headed, scrapeWith({}, "headless"));
    }).toThrow(
      expect.objectContaining(
        refusal(
          "The session's device record fixes its mode; a scrape in that session cannot change it.",
        ),
      ),
    );
    expect(() => {
      refuseRecordOverrides(headed, scrapeWith({}, "headed"));
    }).not.toThrow();
  });

  it("refuses any pinned zone when the record follows the host's zone", () => {
    expect(() => {
      refuseRecordOverrides(
        {
          ...record,
          policy: { locale: "de-DE", timezone: { kind: "host", zone: "Europe/Berlin" } },
        },
        { mode: "headless", pins: { ...noPins, timezone: "Europe/Berlin" } },
      );
    }).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS" }));
  });
});

describe("the cache directory", () => {
  it("defaults to the platform's per-user cache directory", () => {
    const xdg = process.env.XDG_CACHE_HOME;
    const cacheHome = xdg === undefined || xdg === "" ? path.join(homedir(), ".cache") : xdg;

    const expected =
      process.platform === "darwin"
        ? path.join(homedir(), "Library", "Caches", "xrio")
        : path.join(cacheHome, "xrio");

    expect(resolveClientOptions({ mode: "http" }).cacheDir.path).toBe(expected);
  });

  it("resolves a given directory to an absolute path", () => {
    expect(resolveClientOptions({ cacheDir: "relative/cache", mode: "http" }).cacheDir.path).toBe(
      path.resolve("relative/cache"),
    );
  });

  it("refuses an empty directory path", () => {
    expect(() => resolveClientOptions({ cacheDir: " ", mode: "http" })).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "cacheDir must be a non-empty directory path.",
      }),
    );
  });
});
