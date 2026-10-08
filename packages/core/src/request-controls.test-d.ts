import { describe, expectTypeOf, it } from "vite-plus/test";

import type { XrioConfig } from "./config.ts";
import type { ScrapeOptions } from "./types.ts";

describe("request controls", () => {
  it("accepts cookies in every mode but headers only in explicit HTTP mode", () => {
    const http = {
      cookies: ["name=value; Path=/"],
      format: "html",
      headers: { Authorization: "secret" },
      mode: "http",
      url: "https://example.com",
    } satisfies ScrapeOptions;

    const browser = {
      browserPath: "/chrome",
      cookies: ["name=value; HttpOnly"],
      format: "html",
      mode: "headless",
      url: "https://example.com",
    } satisfies ScrapeOptions;

    expectTypeOf(http).toExtend<ScrapeOptions>();
    expectTypeOf(browser).toExtend<ScrapeOptions>();

    // @ts-expect-error Headers cannot scope browser subrequests without Fetch interception.
    const browserHeaders: ScrapeOptions = {
      browserPath: "/chrome",
      format: "html",
      headers: { "x-request": "one" },
      mode: "headless",
      url: "https://example.com",
    };

    // @ts-expect-error Default browser mode cannot accept HTTP headers.
    const inheritedHeaders: ScrapeOptions = {
      format: "html",
      headers: { "x-request": "one" },
      url: "https://example.com",
    };

    void browserHeaders;
    void inheritedHeaders;
  });

  it("takes retries from the scrape section of the config, not from a scrape", () => {
    expectTypeOf({ scrape: { retries: 2 } }).toExtend<XrioConfig>();

    // @ts-expect-error Retries are set in the scrape section of xrio.config.
    const scrapeRetries: ScrapeOptions = { format: "html", retries: 1, url: "https://example.com" };

    void scrapeRetries;
  });
});
