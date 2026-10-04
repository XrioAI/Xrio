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
  ErrorCode,
  HttpIdentityReport,
  IdentityMismatch,
  IdentityReport,
  InvalidOptionsError,
  ScrapeFormat,
  ScrapeResult,
  StructuredContent,
  XrioErrorCode,
} from "./client.ts";

declare const error: unknown;

describe("XrioClient types", () => {
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

  it("takes browserArgs on browser clients only, never per scrape", () => {
    const browserArgs = ["--no-sandbox"];
    const url = "https://example.com";

    expectTypeOf<ClientOptions["browserArgs"]>().toEqualTypeOf<readonly string[] | undefined>();
    void new XrioClient({ browserArgs, browserPath: "/browser" });
    void new XrioClient({ browserArgs, browserPath: "/browser", mode: "headless" });
    void new XrioClient({ browserArgs: ["--no-sandbox"] as const, browserPath: "/browser" });
    // @ts-expect-error An http client has no browser to pass switches to.
    void new XrioClient({ browserArgs, mode: "http" });
    // @ts-expect-error browserArgs needs a browser path, even with a switch list.
    void new XrioClient({ browserArgs });
    // @ts-expect-error browserArgs are switches, not one string.
    void new XrioClient({ browserArgs: "--no-sandbox", browserPath: "/browser" });
    // @ts-expect-error browserArgs belong to the client, not to a scrape.
    void new XrioClient({ mode: "http" }).scrape({ browserArgs, format: "html", url });
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
    expectTypeOf<keyof BrowserIdentityReport["coverage"]>().toEqualTypeOf<CoveredSurface>();
    expectTypeOf<CoverageReason>().toEqualTypeOf<
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
      readonly requestHeaders: Coverage;
    }>();
  });

  it("limits concurrent browsers and closes like a disposable resource", () => {
    expectTypeOf<ClientOptions["maxBrowsers"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<XrioClient["close"]>().toEqualTypeOf<() => Promise<void>>();
    expectTypeOf<XrioClient>().toExtend<AsyncDisposable>();
    expectTypeOf<XrioError<"CLIENT_CLOSED">["details"]>().toEqualTypeOf<undefined>();
    expectTypeOf<XrioError<"BROWSER_LAUNCH_FAILED">["details"]>().toEqualTypeOf<{
      stderr: string;
      mismatches: readonly IdentityMismatch[];
    }>();
    expectTypeOf<IdentityMismatch["surface"]>().toEqualTypeOf<
      "locale" | "timezone" | "gpu" | "window" | "screen" | "leaks" | "media" | "automation"
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
