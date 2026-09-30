import { describe, expectTypeOf, it } from "vite-plus/test";

import { XrioClient } from "./client.ts";
import type { ScrapeFormat, StructuredContent } from "./client.ts";

describe("XrioClient types", () => {
  it("the public API requires explicit formats and complete browser-mode overrides", () => {
    const client = new XrioClient();
    const browser = new XrioClient({ browserPath: "/browser", mode: "headed" });
    const url = "https://example.com";

    expectTypeOf(client.scrape({ format: "html", url })).toEqualTypeOf<Promise<string>>();
    expectTypeOf(client.scrape({ format: "markdown", url })).toEqualTypeOf<Promise<string>>();
    expectTypeOf(client.scrape({ format: "json", url })).toEqualTypeOf<
      Promise<StructuredContent>
    >();
    expectTypeOf(browser.scrape({ format: "json", url })).toEqualTypeOf<
      Promise<StructuredContent>
    >();

    const scrapeSelectedFormat = async (format: ScrapeFormat) =>
      await client.scrape({ format, url });

    expectTypeOf(scrapeSelectedFormat).returns.toEqualTypeOf<Promise<string | StructuredContent>>();

    // @ts-expect-error A format is required, even with client defaults.
    void client.scrape({ url });
    // @ts-expect-error Browser client defaults require a path.
    void new XrioClient({ mode: "headless" });
    // @ts-expect-error Explicit browser overrides require their own path.
    void client.scrape({ format: "html", mode: "headed", url });
    // @ts-expect-error A configured browser path does not weaken override requirements.
    void browser.scrape({ format: "html", mode: "headless", url });
    // @ts-expect-error Timeouts belong to scrape(), not the constructor.
    void new XrioClient({ timeoutMs: 1000 });
  });
});
