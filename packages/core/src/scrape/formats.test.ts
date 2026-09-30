import { describe, expect, it } from "vite-plus/test";

import { assertFormatSupported, buildResult } from "./formats.ts";
import type { OutputFormat, Page, ScrapeRequest } from "./types.ts";

const request = (format: OutputFormat, url = "https://example.com/?a=1&b=2"): ScrapeRequest => ({
  format,
  mode: "http",
  url,
});

const page = (html: string): Page => ({ finalUrl: "https://example.com/final", html, status: 200 });

describe(buildResult, () => {
  it("returns the html untouched with an html content type", () => {
    const result = buildResult(request("html"), page("<p>x</p>"));

    expect(result).toMatchObject({
      content: "<p>x</p>",
      contentType: "text/html; charset=utf-8",
      finalUrl: "https://example.com/final",
      format: "html",
      mode: "http",
      status: 200,
    });
  });

  it("stamps the result with an ISO fetch time", () => {
    const { fetchedAt } = buildResult(request("html"), page(""));

    expect(new Date(fetchedAt).toISOString()).toBe(fetchedAt);
  });

  it("renders json as one object with the page metadata", () => {
    const result = buildResult(request("json"), page("<p>x</p>"));

    expect(result.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(result.content)).toMatchObject({
      finalUrl: "https://example.com/final",
      html: "<p>x</p>",
      status: 200,
      url: "https://example.com/?a=1&b=2",
    });
  });

  it("escapes xml-special characters in urls", () => {
    const { content } = buildResult(request("xml"), page("<p>x</p>"));

    expect(content).toContain("<url>https://example.com/?a=1&amp;b=2</url>");
  });

  it("keeps html verbatim in a CDATA section, splitting any embedded terminator", () => {
    const { content, contentType } = buildResult(request("xml"), page("a]]>b"));

    expect(contentType).toBe("application/xml; charset=utf-8");
    expect(content).toContain("<html><![CDATA[a]]]]><![CDATA[>b]]></html>");
  });

  it("renders csv with a header row and quotes every field, doubling embedded quotes", () => {
    const { content, contentType } = buildResult(request("csv"), page('say "hi",\nbye'));
    const [header, ...rows] = content.split("\n");

    expect(contentType).toBe("text/csv; charset=utf-8");
    expect(header).toBe("url,final_url,status,fetched_at,html");
    expect(rows.join("\n")).toContain('"say ""hi"",\nbye"');
  });
});

describe("format support", () => {
  it.each(["html", "json", "xml", "csv"] as const)("supports %s", (format) => {
    expect(() => {
      assertFormatSupported(format);
    }).not.toThrow();
  });

  it("reports markdown as unsupported, both up front and when building", () => {
    expect(() => {
      assertFormatSupported("md");
    }).toThrow(/not implemented/u);
    expect(() => buildResult(request("md"), page(""))).toThrow(/not implemented/u);
  });
});
