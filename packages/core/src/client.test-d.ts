import { describe, expectTypeOf, it } from "vite-plus/test";

import { isXrioError, XrioClient, XrioError } from "./client.ts";
import type {
  BlockEvidence,
  BlockReport,
  BlockVerdict,
  BrowserIdentityReport,
  ChallengeOutcome,
  ChallengeReport,
  ChallengeRound,
  ClientOptions,
  Coverage,
  CoverageReason,
  CoveredSurface,
  DisplayOptions,
  ErrorCode,
  HardwareOptions,
  HostConfig,
  HttpIdentityReport,
  IdentityMismatch,
  IdentityReport,
  IdentityTell,
  InvalidOptionsError,
  ScrapeFormat,
  ScrapeOptions,
  ScrapeResult,
  StructuredContent,
  XrioErrorCode,
  XrioConfig,
} from "./client.ts";
import type { Deadline } from "./deadline.ts";
import type { ProxyConfig } from "./proxy/config.ts";
import type { ProxyInfo } from "./proxy/info.ts";
import { ProxyManager } from "./proxy/manager.ts";
import type { RotationSignal } from "./proxy/manager.ts";

declare const error: unknown;

declare const deadline: Deadline;

describe("XrioClient types", () => {
  it("allows selectors only in browser scrape options", () => {
    const browser: ScrapeOptions = {
      browserPath: "/chrome",
      format: "html",
      mode: "headless",
      url: "https://example.test/",
      waitFor: { selector: "#ready" },
    };

    expectTypeOf(browser.waitFor).toEqualTypeOf<{ selector: string } | undefined>();

    // @ts-expect-error HTTP mode cannot wait on browser selectors.
    const http: ScrapeOptions = {
      format: "html",
      mode: "http",
      url: "https://example.test/",
      waitFor: { selector: "#ready" },
    };

    expectTypeOf(http).toEqualTypeOf<ScrapeOptions>();
  });

  it("keeps the proxy manager internal while exposing typed configuration", () => {
    const config = {
      proxy: {
        session: { format: "numeric", length: 8 },
        url: "http://user-{session}:password@proxy.test",
      },
    } satisfies XrioConfig;

    const manager = new ProxyManager(config.proxy);

    expectTypeOf<keyof ProxyManager>().toEqualTypeOf<
      "getProxyConnectionString" | "getProxyInfo" | "shouldRotateSession" | "changeSession"
    >();

    expectTypeOf(manager.getProxyConnectionString()).toEqualTypeOf<string>();
    expectTypeOf(manager.changeSession()).toEqualTypeOf<string>();
    expectTypeOf(manager.getProxyInfo("connection", deadline)).toEqualTypeOf<Promise<ProxyInfo>>();
    expectTypeOf(manager.shouldRotateSession("connection", "blocked")).toEqualTypeOf<boolean>();
    expectTypeOf<
      Parameters<ProxyManager["shouldRotateSession"]>[1]
    >().toEqualTypeOf<RotationSignal>();

    // @ts-expect-error The caller must supply the proxy configuration explicitly.
    void new ProxyManager();

    // @ts-expect-error Explicit session settings require a literal placeholder.
    const missingPlaceholder: ProxyConfig = { session: { length: 8 }, url: "http://proxy.test" };

    const suppliedId: ProxyConfig = {
      // @ts-expect-error Replacement session IDs are generated, not configured.
      session: { id: "12345678" },
      url: "http://user-{session}@proxy.test",
    };

    void missingPlaceholder;
    void suppliedId;
  });

  it("types the host section and rejects unknown top-level keys", () => {
    const config = {
      $schema: "./node_modules/@xrio/core/xrio.schema.json",
      host: {
        browserArgs: ["--no-sandbox"],
        display: {
          screen: [{ height: 1080, weight: 2, width: 1920 }],
          taskbar: { bottom: 48 },
          window: "maximized",
        },
        hardware: { cores: 8, gpuPolicy: "matched", memoryGb: 16 },
        locale: "de-DE",
        timezone: "Europe/Berlin",
      },
      proxy: { url: "http://proxy.test" },
    } satisfies XrioConfig;

    expectTypeOf(config.host.hardware.memoryGb).toEqualTypeOf<16>();
    expectTypeOf<NonNullable<HostConfig["display"]>>().toEqualTypeOf<DisplayOptions>();
    expectTypeOf<NonNullable<HostConfig["hardware"]>>().toEqualTypeOf<HardwareOptions>();
    expectTypeOf<HardwareOptions["memoryGb"]>().toEqualTypeOf<
      | 2
      | 4
      | 8
      | 16
      | 32
      | readonly ({ value: 2 | 4 | 8 | 16 | 32 } & { weight: number })[]
      | undefined
    >();
    expectTypeOf<HardwareOptions["gpuPolicy"]>().toEqualTypeOf<
      "matched" | "announce" | undefined
    >();

    const unknownSection = {
      // @ts-expect-error Only proxy and host are config sections.
      browser: { futureSetting: true },
    } satisfies XrioConfig;

    const unknownHostField = {
      // @ts-expect-error Host takes locale, timezone, display, hardware and browserArgs.
      host: { dpr: 2 },
    } satisfies XrioConfig;

    const unmeasuredMemory = {
      // @ts-expect-error Reportable memory is 2, 4, 8, 16 or 32 GB.
      host: { hardware: { memoryGb: 12 } },
    } satisfies XrioConfig;

    const positionedWindow = {
      host: { display: { window: { height: 800, width: 1200, x: 10, y: 20 } } },
    } satisfies XrioConfig;

    const halfPositionedWindow = {
      // @ts-expect-error A window takes x and y together or neither.
      host: { display: { window: { height: 800, width: 1200, x: 10 } } },
    } satisfies XrioConfig;

    const sizedMaximizedRow = {
      // @ts-expect-error A maximized row takes no size or position.
      host: { display: { window: [{ maximized: true, weight: 1, width: 1200 }] } },
    } satisfies XrioConfig;

    void unknownSection;
    void unknownHostField;
    void unmeasuredMemory;
    void positionedWindow;
    void halfPositionedWindow;
    void sizedMaximizedRow;
  });

  it("the public API requires explicit formats and complete browser-mode overrides", () => {
    const client = new XrioClient({ mode: "http" });
    const browser = new XrioClient({ browserPath: "/browser" });
    const url = "https://example.com";

    expectTypeOf(client.scrape({ format: "html", url })).toEqualTypeOf<
      Promise<ScrapeResult<"html">>
    >();
    expectTypeOf(client.scrape({ format: "markdown", url })).toEqualTypeOf<
      Promise<ScrapeResult<"markdown">>
    >();
    expectTypeOf(client.scrape({ format: "json", url })).toEqualTypeOf<
      Promise<ScrapeResult<"json">>
    >();
    expectTypeOf(browser.scrape({ format: "json", url })).toEqualTypeOf<
      Promise<ScrapeResult<"json">>
    >();
    expectTypeOf<ScrapeResult<"html">["data"]>().toEqualTypeOf<string>();
    expectTypeOf<ScrapeResult<"markdown">["data"]>().toEqualTypeOf<string>();
    expectTypeOf<ScrapeResult<"json">["data"]>().toEqualTypeOf<StructuredContent>();

    const scrapeSelectedFormat = async (format: ScrapeFormat) => {
      const result = await client.scrape({ format, url });

      if (result.format === "json") {
        expectTypeOf(result.data).toEqualTypeOf<StructuredContent>();
      } else {
        expectTypeOf(result.data).toEqualTypeOf<string>();
      }

      return result;
    };

    expectTypeOf(scrapeSelectedFormat).returns.toEqualTypeOf<Promise<ScrapeResult>>();

    // @ts-expect-error A format is required, even with client defaults.
    void client.scrape({ url });
    // @ts-expect-error The default headed mode requires a browser path.
    void new XrioClient();
    // @ts-expect-error The default headed mode requires a browser path.
    void new XrioClient({});
    // @ts-expect-error Browser client defaults require a path.
    void new XrioClient({ mode: "headless" });
    // @ts-expect-error Explicit browser overrides require their own path.
    void client.scrape({ format: "html", mode: "headed", url });
    // @ts-expect-error A configured browser path does not weaken override requirements.
    void browser.scrape({ format: "html", mode: "headless", url });
    // @ts-expect-error Timeouts belong to scrape(), not the constructor.
    void new XrioClient({ mode: "http", timeoutMs: 1000 });
  });

  it("keeps browser defaults on every client, whatever its default mode", () => {
    const browserArgs = ["--no-sandbox"];
    const url = "https://example.com";

    expectTypeOf<ClientOptions["browserArgs"]>().toEqualTypeOf<readonly string[] | undefined>();
    void new XrioClient({ browserArgs, browserPath: "/browser" });
    void new XrioClient({ browserArgs, browserPath: "/browser", mode: "headless" });
    void new XrioClient({ browserArgs: ["--no-sandbox"] as const, browserPath: "/browser" });
    void new XrioClient({ browserArgs, mode: "http" });
    void new XrioClient({ browserArgs, browserPath: "/browser", mode: "http" });
    // @ts-expect-error browserArgs needs a browser path, even with a switch list.
    void new XrioClient({ browserArgs });
    // @ts-expect-error browserArgs are switches, not one string.
    void new XrioClient({ browserArgs: "--no-sandbox", browserPath: "/browser" });
    // @ts-expect-error browserArgs belong to the client, not to a scrape.
    void new XrioClient({ mode: "http" }).scrape({ browserArgs, format: "html", url });
  });

  it("takes a config file path as a client option", () => {
    const url = "https://example.com";

    expectTypeOf<ClientOptions["configFile"]>().toEqualTypeOf<string | undefined>();
    void new XrioClient({ configFile: "deploy/xrio.config.ts", mode: "http" });
    // @ts-expect-error true is not a path.
    void new XrioClient({ configFile: true, mode: "http" });
    // @ts-expect-error configFile belongs to the client, not to a scrape.
    void new XrioClient({ mode: "http" }).scrape({ configFile: "a.ts", format: "html", url });
  });

  it("excludes identity settings from the client and scrape APIs", () => {
    const client = new XrioClient({ mode: "http" });
    const url = "https://example.com";
    expectTypeOf<
      Extract<keyof ClientOptions, "locale" | "timezone" | "display" | "hardware">
    >().toBeNever();
    // @ts-expect-error Locale belongs to xrio.config's host section.
    void new XrioClient({ locale: "de-DE", mode: "http" });
    // @ts-expect-error Timezone belongs to xrio.config's host section.
    void new XrioClient({ browserPath: "/browser", timezone: "Europe/Berlin" });
    // @ts-expect-error Display belongs to xrio.config's host section.
    void new XrioClient({ browserPath: "/browser", display: {} });
    // @ts-expect-error Hardware belongs to xrio.config's host section.
    void new XrioClient({ browserPath: "/browser", hardware: {} });
    // @ts-expect-error Locale is not a scrape override.
    void client.scrape({ format: "html", locale: "de-DE", url });
    // @ts-expect-error Timezone is not a scrape override.
    void client.scrape({ format: "html", timezone: "Europe/Berlin", url });
    // @ts-expect-error Display is not a scrape override.
    void client.scrape({ display: {}, format: "html", url });
    // @ts-expect-error Hardware is not a scrape override.
    void client.scrape({ format: "html", hardware: {}, url });
  });

  it("exposes each response header as an optional string and cookies separately", () => {
    expectTypeOf<ScrapeResult["headers"]["content-type"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ScrapeResult["cookies"]>().toEqualTypeOf<string[]>();
  });

  it("accepts a proxy as a client default and as a per-scrape override", () => {
    const client = new XrioClient({ mode: "http", proxy: "socks5h://proxy.test:1080" });

    expectTypeOf<ClientOptions["proxy"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf(
      client.scrape({
        format: "html",
        proxy: "http://proxy.test:8000",
        url: "https://example.com",
      }),
    ).toEqualTypeOf<Promise<ScrapeResult<"html">>>();
  });

  it("reports a block on every result and on unsupported-content errors", () => {
    expectTypeOf<ScrapeResult["block"]>().toEqualTypeOf<BlockReport>();
    expectTypeOf<BlockReport["verdict"]>().toEqualTypeOf<BlockVerdict>();
    expectTypeOf<BlockVerdict>().toEqualTypeOf<
      "ok" | "suspect" | "blocked" | "queued" | "unknown"
    >();
    expectTypeOf<BlockReport["evidence"]>().toEqualTypeOf<BlockEvidence[]>();
    expectTypeOf<BlockEvidence["tier"]>().toEqualTypeOf<"E0" | "E1" | "E2" | "E3">();
    expectTypeOf<BlockReport["challenge"]>().toEqualTypeOf<ChallengeReport | null>();
    expectTypeOf<ChallengeReport["rounds"]>().toEqualTypeOf<ChallengeRound[]>();
    expectTypeOf<ChallengeOutcome>().toEqualTypeOf<
      "passed" | "passed_in_place" | "rounds_exhausted" | "budget_exhausted" | "deadline"
    >();
    expectTypeOf<
      XrioError<"UNSUPPORTED_CONTENT_TYPE">["details"]["block"]
    >().toEqualTypeOf<BlockReport>();
  });

  it("reports the identity on every result, narrowed by its mode", () => {
    const client = new XrioClient({ mode: "http" });

    const identityOf = async () => {
      const { identity } = await client.scrape({ format: "html", url: "https://example.com" });

      if (identity.mode === "http") {
        expectTypeOf(identity).toEqualTypeOf<HttpIdentityReport>();
        expectTypeOf(identity.profile.chromeMajor).toEqualTypeOf<number>();
      } else {
        expectTypeOf(identity).toEqualTypeOf<BrowserIdentityReport>();
        expectTypeOf(identity.mode).toEqualTypeOf<"headless" | "headed">();
        expectTypeOf(identity.coverage.webglStrings).toEqualTypeOf<Coverage>();
      }

      return identity;
    };

    expectTypeOf(identityOf).returns.toEqualTypeOf<Promise<IdentityReport>>();
    expectTypeOf<ScrapeResult<"json">["identity"]>().toEqualTypeOf<IdentityReport>();
    expectTypeOf<BrowserIdentityReport["binary"]>().toEqualTypeOf<{
      readonly version: string;
      readonly fork: "xrio" | null;
      readonly commit: string | null;
      readonly dirty: number | null;
    }>();
    expectTypeOf<"fork-commit-unreadable">().toExtend<IdentityTell>();
    expectTypeOf<"flag-infobar">().toExtend<IdentityTell>();
    expectTypeOf<keyof BrowserIdentityReport["coverage"]>().toEqualTypeOf<CoveredSurface>();
    expectTypeOf<CoverageReason>().toEqualTypeOf<
      | "fonts-drift"
      | "insecure-origin"
      | "lanes-only"
      | "no-request-log"
      | "no-time"
      | "not-observed"
      | "read-failed"
    >();
    expectTypeOf<Extract<Coverage, { state: "cached" }>>().toEqualTypeOf<{
      readonly state: "cached";
      readonly key: string;
      readonly ageMs: number;
    }>();
    expectTypeOf<HttpIdentityReport["coverage"]>().toEqualTypeOf<{
      readonly httpProfileSkew: Coverage;
      readonly requestHeaders: Coverage;
    }>();
  });

  it("limits concurrent browsers and closes like a disposable resource", () => {
    expectTypeOf<ClientOptions["maxBrowsers"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ClientOptions["cacheDir"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<XrioClient["close"]>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<XrioClient>().toExtend<AsyncDisposable>();
    expectTypeOf<XrioError<"CLIENT_CLOSED">["details"]>().toEqualTypeOf<undefined>();
    expectTypeOf<XrioError<"BROWSER_LAUNCH_FAILED">["details"]>().toEqualTypeOf<{
      stderr: string;
      mismatches: readonly IdentityMismatch[];
    }>();
    expectTypeOf<IdentityMismatch["surface"]>().toEqualTypeOf<
      | "seed"
      | "locale"
      | "timezone"
      | "gpu"
      | "hardware"
      | "window"
      | "screen"
      | "fonts"
      | "speech"
      | "leaks"
      | "media"
      | "automation"
    >();
  });

  it("narrows errors and their details by code", () => {
    expectTypeOf<Exclude<ErrorCode, XrioErrorCode>>().toEqualTypeOf<"INVALID_OPTIONS">();

    if (isXrioError(error, "UNSUPPORTED_CONTENT_TYPE")) {
      expectTypeOf(error).toEqualTypeOf<XrioError<"UNSUPPORTED_CONTENT_TYPE">>();
      expectTypeOf(error.details.body).toEqualTypeOf<string>();
      expectTypeOf(error.details.status).toEqualTypeOf<number>();
    }

    if (isXrioError(error, "INVALID_OPTIONS")) {
      expectTypeOf(error).toEqualTypeOf<InvalidOptionsError>();
      expectTypeOf(error).toExtend<TypeError>();
    }

    if (isXrioError(error)) {
      expectTypeOf(error.code).toEqualTypeOf<ErrorCode>();

      if (error.code === "UNSUPPORTED_CONTENT_TYPE") {
        expectTypeOf(error.details.cookies).toEqualTypeOf<string[]>();
      }
    }

    expectTypeOf<XrioError<"TIMEOUT">["details"]>().toEqualTypeOf<undefined>();
    expectTypeOf<XrioError<"PROXY_CONNECT_FAILED">["details"]>().toEqualTypeOf<{
      status: number;
    }>();
    // @ts-expect-error Unsupported-content errors require their response details.
    void new XrioError("UNSUPPORTED_CONTENT_TYPE", "Missing details");
    // @ts-expect-error A code type argument needs the code it names.
    void isXrioError<"TIMEOUT">(error);
    // @ts-expect-error Details must belong to the code, even with a widened code type.
    void new XrioError<XrioErrorCode>("PROXY_CONNECT_FAILED", "Missing status", {
      details: undefined,
    });
    // @ts-expect-error Codes are a closed set.
    void isXrioError(error, "ERR_INVALID_URL");
  });
});
