import { describe, expectTypeOf, it } from "vite-plus/test";

import type { ScrapeOptions } from "./types.ts";

describe("request controls", () => {
  it("accepts cookies in every mode", () => {
    const http = {
      cookies: ["name=value; Path=/"],
      format: "html",
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
  });
});
