import { describe, expect, it } from "vite-plus/test";

import { extractContent, renderMarkdown } from "./formats.ts";

describe("content formats", () => {
  it.each([
    { base: "", href: "https://example.com/pages/tea" },
    { base: '<base href="../docs/"><base href="/ignored/">', href: "https://example.com/docs/tea" },
    {
      base: '<base href="http://["><base href="/ignored/">',
      href: "https://example.com/pages/tea",
    },
  ])("shares Markdown URL resolution with structured content: $base", ({ base, href }) => {
    const document = {
      html: `<p><a href="tea">Tea</a></p>${base}`,
      url: "https://example.com/pages/catalog",
    };

    const markdown = renderMarkdown(document);
    const content = extractContent(document);

    expect(markdown).toBe(`[Tea](${href})`);
    expect(content.content.markdown).toBe(markdown);
    expect(content.content.links).toStrictEqual([{ href, text: "Tea" }]);
  });
});
