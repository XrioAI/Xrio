import { homedir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { resolveHostConfig } from "./host-config.ts";
import { resolveClientOptions, resolveScrapeIntent } from "./options.ts";

const page = { format: "html", url: "https://example.com" } as const;

const missingBrowserPath = {
  code: "INVALID_OPTIONS",
  message: "browserPath is required for headed mode.",
  name: "TypeError",
};

const refusalFor = (message: string) => ({ code: "INVALID_OPTIONS", message, name: "TypeError" });

describe("scrape options", () => {
  it("accepts browser selectors and refuses them when the effective mode is HTTP", () => {
    const browser = resolveClientOptions({ browserPath: "/chrome", mode: "headless" });
    const http = resolveClientOptions({ mode: "http" });
    expect(
      resolveScrapeIntent({ ...page, waitFor: { selector: "#ready" } }, browser).source,
    ).toMatchObject({ waitFor: { selector: "#ready" } });
    expect(() => resolveScrapeIntent({ ...page, waitFor: { selector: "#ready" } }, http)).toThrow(
      expect.objectContaining(refusalFor("waitFor is only supported in browser modes.")),
    );
    expect(() =>
      // @ts-expect-error Explicit HTTP mode rejects browser selectors at compile time too.
      resolveScrapeIntent({ ...page, mode: "http", waitFor: { selector: "#ready" } }, browser),
    ).toThrow(expect.objectContaining(refusalFor("waitFor is only supported in browser modes.")));
  });

  it("rejects an empty selector at the options boundary", () => {
    const defaults = resolveClientOptions({ browserPath: "/chrome" });
    expect(() => resolveScrapeIntent({ ...page, waitFor: { selector: " " } }, defaults)).toThrow(
      expect.objectContaining(refusalFor("waitFor must contain a non-empty selector string.")),
    );
    // @ts-expect-error JavaScript callers can supply malformed selector options.
    expect(() => resolveScrapeIntent({ ...page, waitFor: null }, defaults)).toThrow(
      expect.objectContaining(refusalFor("waitFor must contain a non-empty selector string.")),
    );
  });

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
    "http://user-{session}:secret@proxy.test",
    "http://user:secret-{session}@proxy.test",
    "http://user-%7Bsession%7D:secret@proxy.test",
  ])("rejects templates on both public boundaries: %s", (proxy) => {
    const expected: unknown = expect.objectContaining(
      refusalFor(
        "Proxy templates are only supported in xrio.config. Pass a concrete proxy URL to the client or scrape method.",
      ),
    );

    expect(() => resolveClientOptions({ mode: "http", proxy })).toThrow(expected);
    expect(() =>
      resolveScrapeIntent({ ...page, proxy }, resolveClientOptions({ mode: "http" })),
    ).toThrow(expected);
  });

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
      url: new URL(proxy).href,
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
      url: "http://us%3Aer:p%2540ss%20word@proxy.test:8000/",
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

  it("refuses configFile on a scrape, even from an options object the types did not check", () => {
    const defaults = resolveClientOptions({ mode: "http" });
    const unchecked = { ...page, configFile: "other.config.ts" };
    const absent = { ...page, configFile: undefined };

    expect(() => resolveScrapeIntent(unchecked, defaults)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "configFile is a client option.",
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

    expect(resolveScrapeIntent(page, defaults).source).toStrictEqual({ headers: {}, mode: "http" });
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

describe("host settings from xrio.config", () => {
  const host = resolveHostConfig({
    browserArgs: ["--no-sandbox"],
    hardware: { cores: 8 },
    locale: "de-DE",
    noise: "on",
    timezone: "Europe/Berlin",
  });

  const browser = { browserPath: "/browser", mode: "headless" } as const;

  it("reach every scrape of the client as its identity pins", () => {
    const defaults = resolveClientOptions(browser, host);

    expect(resolveScrapeIntent(page, defaults).identity).toStrictEqual({
      display: undefined,
      hardware: {
        cores: [{ value: 8, weight: 1 }],
        gpu: undefined,
        gpuPolicy: undefined,
        memoryGb: undefined,
      },
      locale: "de-DE",
      noise: "on",
      timezone: "Europe/Berlin",
    });
    expect(resolveScrapeIntent({ ...page, mode: "http" }, defaults).identity.locale).toBe("de-DE");
  });

  it("hand the config's browserArgs to browser scrapes", () => {
    const defaults = resolveClientOptions(browser, host);

    expect(resolveScrapeIntent(page, defaults).source).toStrictEqual({
      browserArgs: ["--no-sandbox"],
      browserPath: "/browser",
      mode: "headless",
    });
  });

  it("are replaced whole by the client's browserArgs, even an empty list", () => {
    expect(
      resolveScrapeIntent(
        page,
        resolveClientOptions({ ...browser, browserArgs: ["--disable-gpu-compositing"] }, host),
      ).source,
    ).toMatchObject({ browserArgs: ["--disable-gpu-compositing"] });
    expect(
      resolveScrapeIntent(page, resolveClientOptions({ ...browser, browserArgs: [] }, host)).source,
    ).toMatchObject({ browserArgs: [] });
  });

  it("leave browserArgs empty when neither the client nor the config sets them", () => {
    expect(
      resolveScrapeIntent(page, resolveClientOptions(browser, resolveHostConfig({}))).source,
    ).toMatchObject({
      browserArgs: [],
    });
  });
});

describe("identity options moved to xrio.config", () => {
  it.each(["locale", "timezone", "display", "hardware", "noise"])(
    "rejects %s on both public boundaries",
    (field) => {
      const options = { mode: "http", [field]: undefined } as const;

      const expected: unknown = expect.objectContaining(
        refusalFor(
          `${field} is not a client or scrape option. Set it in the host section of xrio.config.`,
        ),
      );

      expect(() => resolveClientOptions(options)).toThrow(expected);
      expect(() =>
        resolveScrapeIntent({ ...page, [field]: {} }, resolveClientOptions({ mode: "http" })),
      ).toThrow(expected);
    },
  );
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

const directoriesFor = (stateDir?: string) => {
  const defaults = resolveClientOptions({ mode: "http", stateDir });

  return { databaseDir: defaults.databaseDir, stateDir: defaults.stateDir };
};

describe("the session directories", () => {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome = xdg === undefined || xdg === "" ? path.join(homedir(), ".local", "state") : xdg;

  const defaults = {
    databaseDir: path.join(homedir(), ".xrio"),
    stateDir:
      process.platform === "darwin"
        ? path.join(homedir(), "Library", "Application Support", "xrio")
        : path.join(stateHome, "xrio"),
  };

  it("keep the database in .xrio and the profiles in the per-user state directory by default", () => {
    expect(directoriesFor()).toStrictEqual(defaults);
  });

  it("keep both in a stateDir the client sets", () => {
    expect(directoriesFor("relative/state")).toStrictEqual({
      databaseDir: path.resolve("relative/state"),
      stateDir: path.resolve("relative/state"),
    });
  });

  it("refuse a stateDir set to either default directory", () => {
    for (const directory of [defaults.stateDir, defaults.databaseDir]) {
      expect(() => directoriesFor(directory)).toThrow(
        expect.objectContaining(
          refusalFor(
            `stateDir must not be ${directory}, which Xrio uses when stateDir is unset. Leave stateDir unset or choose another directory.`,
          ),
        ),
      );
    }
  });
});
