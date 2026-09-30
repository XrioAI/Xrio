import { once } from "node:events";
import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { XrioClient } from "./client.ts";

const html = `<!doctype html>
<html lang="en">
<head>
  <title>Head title &amp; metadata</title>
  <meta name="description" content="A test page">
  <base href="../docs/">
  <base href="/ignored/">
  <style>.do-not-render-style { color: red }</style>
</head>
<body>
  <nav><a href="/navigation">Navigation</a></nav>
  <header><h1>Catalog</h1></header>
  <aside style="position: absolute">Keep the sidebar</aside>
  <p><a href="tea">Tea</a> and <a href="tea">Tea again</a></p>
  <p><a href="#details">Details</a></p>
  <img src="tea.png" alt="Tea photo">
  <img src="tea.png" alt="Tea photo again">
  <table><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td>5</td></tr></table>
  <pre><code class="language-js">const tea = true;</code></pre>
  <noscript><p>Fallback <a href="help">Help</a></p></noscript>
  <template><a href="hidden">Template link</a><img src="hidden.png"></template>
  <script>doNotRenderScript()</script>
  <footer><a href="contact">Contact</a></footer>
</body>
</html>`;

const server = createServer((request, response) => {
  switch (request.url ?? "/") {
    case "/redirect": {
      response.writeHead(302, { location: "/pages/document" }).end();

      return;
    }

    case "/plain": {
      response.writeHead(200, { "content-type": "text/plain" }).end("Not HTML");

      return;
    }

    case "/json": {
      response.writeHead(200, { "content-type": "application/json" }).end("{}");

      return;
    }

    case "/missing-type": {
      response.writeHead(200).end(html);

      return;
    }

    case "/failed": {
      response.writeHead(404, { "content-type": "text/html" }).end(html);

      return;
    }

    case "/slow": {
      response.writeHead(200, { "content-type": "text/html" });
      response.flushHeaders();

      return;
    }

    case "/fragment": {
      response.writeHead(200, { "content-type": "text/html" }).end("<p>Body only</p>");

      return;
    }

    case "/implicit-head": {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<title>Title</title><p>Body only</p>");

      return;
    }

    default: {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    }
  }
});

describe(XrioClient, () => {
  let origin: string;

  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns either a TCP address, a pipe path, or null.
    if (address === null || typeof address === "string") {
      throw new Error("Test server did not receive a TCP port.");
    }

    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });

  it("preserves HTML and shares body-wide Markdown with JSON after redirects", async () => {
    const client = new XrioClient();
    const url = `${origin}/redirect`;
    const source = await client.scrape({ format: "html", url });
    const markdown = await client.scrape({ format: "markdown", url });
    const page = await client.scrape({ format: "json", url });

    expect(source).toBe(html);
    expect(page.content.markdown).toBe(markdown);
    expect(page.metadata).toStrictEqual({
      description: "A test page",
      language: "en",
      title: "Head title & metadata",
      url: `${origin}/pages/document`,
    });
    expect(page.content.links).toStrictEqual([
      { href: `${origin}/navigation`, text: "Navigation" },
      { href: `${origin}/docs/tea`, text: "Tea" },
      { href: `${origin}/docs/tea`, text: "Tea again" },
      { href: `${origin}/docs/#details`, text: "Details" },
      { href: `${origin}/docs/help`, text: "Help" },
      { href: `${origin}/docs/hidden`, text: "Template link" },
      { href: `${origin}/docs/contact`, text: "Contact" },
    ]);
    expect(page.content.images).toStrictEqual([
      { alt: "Tea photo", src: `${origin}/docs/tea.png` },
      { alt: "Tea photo again", src: `${origin}/docs/tea.png` },
      { alt: "", src: `${origin}/docs/hidden.png` },
    ]);
  });

  it("converts the whole body while excluding document-head content", async () => {
    const page = await new XrioClient().scrape({ format: "json", url: `${origin}/redirect` });
    const { markdown, text } = page.content;

    for (const fragment of [
      "# Catalog",
      `[Tea](${origin}/docs/tea)`,
      `[Details](${origin}/docs/#details)`,
      `![Tea photo](${origin}/docs/tea.png)`,
      "```js\nconst tea = true;",
    ]) {
      expect(markdown).toContain(fragment);
    }

    expect(markdown).toMatch(/\|\s*Item\s*\|\s*Price\s*\|/u);

    for (const output of [markdown, text]) {
      for (const kept of ["Navigation", "Keep the sidebar", "Fallback", "Help", "Contact"]) {
        expect(output).toContain(kept);
      }

      for (const excluded of ["Head title", "do-not-render-style", "doNotRenderScript"]) {
        expect(output).not.toContain(excluded);
      }
    }
  });

  it("handles omitted document wrappers and missing metadata", async () => {
    const client = new XrioClient();
    const page = await client.scrape({ format: "json", url: `${origin}/fragment` });
    const titled = await client.scrape({ format: "json", url: `${origin}/implicit-head` });

    expect(page).toStrictEqual({
      content: { images: [], links: [], markdown: "Body only", text: "Body only" },
      metadata: { description: null, language: null, title: null, url: `${origin}/fragment` },
    });
    expect(titled.metadata.title).toBe("Title");
    expect(titled.content.markdown).toBe("Body only");
    expect(titled.content.text).toBe("Body only");
  });

  it("keeps mode overrides local to one call and rejects browser modes", async () => {
    const client = new XrioClient({ browserPath: "/browser", mode: "headed" });
    const url = `${origin}/fragment`;

    await expect(client.scrape({ format: "html", url })).rejects.toThrow(
      "headed mode is not implemented",
    );
    await expect(client.scrape({ format: "html", mode: "http", url })).resolves.toBe(
      "<p>Body only</p>",
    );
    await expect(client.scrape({ format: "html", url })).rejects.toThrow(
      "headed mode is not implemented",
    );
    await expect(
      new XrioClient().scrape({ browserPath: "/browser", format: "json", mode: "headless", url }),
    ).rejects.toThrow("headless mode is not implemented");
  });

  it("rejects HTTP failures with their status and URL", async () => {
    const client = new XrioClient();

    await expect(client.scrape({ format: "html", url: `${origin}/failed` })).rejects.toThrow(
      `HTTP 404 while scraping ${origin}/failed`,
    );
  });

  it.each(["/plain", "/json", "/missing-type"])(
    "rejects non-HTML responses from %s",
    async (path) => {
      await expect(
        new XrioClient().scrape({ format: "json", url: `${origin}${path}` }),
      ).rejects.toThrow("Expected HTML");
    },
  );

  it("validates URLs before fetching", async () => {
    const client = new XrioClient();

    await expect(client.scrape({ format: "html", url: "file:///tmp/page.html" })).rejects.toThrow(
      "HTTP or HTTPS",
    );
    await expect(client.scrape({ format: "html", url: "relative/path" })).rejects.toThrow(
      "Invalid URL",
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid timeout %s",
    async (timeoutMs) => {
      await expect(
        new XrioClient().scrape({ format: "html", timeoutMs, url: origin }),
      ).rejects.toThrow("timeoutMs must be an integer");
    },
  );

  it("defaults to 60 seconds and allows a per-call timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = new XrioClient();

    try {
      await client.scrape({ format: "html", url: `${origin}/fragment` });
      expect(timeout).toHaveBeenCalledWith(60_000);
      await expect(
        client.scrape({ format: "html", timeoutMs: 100, url: `${origin}/slow` }),
      ).rejects.toThrow(/abort|timeout/iu);
      expect(timeout).toHaveBeenLastCalledWith(100);
    } finally {
      timeout.mockRestore();
    }
  });

  it("allows callers to abort before fetching or during a request", async () => {
    const client = new XrioClient();
    const controller = new AbortController();
    server.once("request", () => {
      controller.abort();
    });

    const pending = client.scrape({
      format: "html",
      signal: controller.signal,
      url: `${origin}/slow`,
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      client.scrape({ format: "html", signal: controller.signal, url: origin }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.scrape({ format: "html", url: `${origin}/fragment` })).resolves.toBe(
      "<p>Body only</p>",
    );
  });
});
