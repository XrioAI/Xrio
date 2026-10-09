import { describe, expect, it } from "vite-plus/test";

import { extractContent, renderMarkdown } from "./formats.ts";

describe("content formats", () => {
  it("ignores a noscript base URL after scripts ran", () => {
    const document = {
      html: '<html><head><noscript><base href="https://fallback.test/"><meta name="description" content="Fallback description"></noscript><meta name="description" content="Visible description"></head><body><a href="tea">Tea</a><img src="tea.png" alt="Tea"></body></html>',
      scriptsRan: true,
      url: "https://example.test/pages/",
    };

    const { content, metadata } = extractContent(document);
    expect(metadata.description).toBe("Visible description");
    expect(renderMarkdown(document)).toContain("[Tea](https://example.test/pages/tea)");
    expect(content.links).toStrictEqual([{ href: "https://example.test/pages/tea", text: "Tea" }]);
    expect(content.images).toStrictEqual([
      { alt: "Tea", src: "https://example.test/pages/tea.png" },
    ]);
    expect(extractContent({ ...document, scriptsRan: false }).content.links).toStrictEqual([
      { href: "https://fallback.test/tea", text: "Tea" },
    ]);
  });

  it("keeps noscript in HTTP content and omits it after scripts ran", () => {
    const html =
      '<html><body><p>Visible</p><noscript><a href="/fallback">Fallback</a><img src="/fallback.png" alt="Hidden"></noscript></body></html>';

    const document = { html, scriptsRan: true, url: "https://example.test/" };
    const { content } = extractContent(document);
    expect(content.links).toStrictEqual([]);
    expect(content.images).toStrictEqual([]);
    expect(content.text).toBe("Visible");
    expect(content.markdown).toBe("Visible");
    expect(extractContent({ ...document, scriptsRan: false }).content.links).toStrictEqual([
      { href: "https://example.test/fallback", text: "Fallback" },
    ]);
  });

  it.each([
    { base: "", href: "https://example.com/pages/tea" },
    { base: '<base href="../docs/"><base href="/ignored/">', href: "https://example.com/docs/tea" },
    {
      base: '<base href="http://["><base href="/ignored/">',
      href: "https://example.com/pages/tea",
    },
  ])("shares Markdown URL resolution with structured content: $base", ({ base, href }) => {
    const document = {
      cookies: [],
      headers: {},
      html: `<p><a href="tea">Tea</a></p>${base}`,
      status: 200,
      url: "https://example.com/pages/catalog",
    };

    const markdown = renderMarkdown(document);
    const content = extractContent(document);

    expect(markdown).toBe(`[Tea](${href})`);
    expect(content.content.markdown).toBe(markdown);
    expect(content.content.links).toStrictEqual([{ href, text: "Tea" }]);
  });
});
