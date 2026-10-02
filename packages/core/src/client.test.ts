import type { IncomingMessage, ServerResponse } from "node:http";
import { inspect } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { isXrioError, XrioClient, XrioError } from "./client.ts";
import { startFixtureServer } from "./testing/fixture-server.ts";
import type { FixtureServer } from "./testing/fixture-server.ts";

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

const cookies = [
  "session=abc; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/; HttpOnly",
  "language=en; Path=/",
];

const previewBytes = 65_536;

let onRequest: (() => void) | undefined;

const routes = (request: IncomingMessage, response: ServerResponse) => {
  onRequest?.();
  onRequest = undefined;

  const url = new URL(request.url ?? "/", "http://localhost");
  const status = Number(url.searchParams.get("status") ?? 200);

  switch (url.pathname) {
    case "/waiting": {
      break;
    }

    case "/redirect": {
      response.writeHead(302, { location: "/pages/document", "x-source": "redirect" }).end();

      return;
    }

    case "/plain": {
      response.writeHead(200, { "content-type": "text/plain" }).end("Not HTML");

      return;
    }

    case "/json": {
      response
        .writeHead(status, { "content-type": "application/json", "set-cookie": cookies })
        .end("{}");

      return;
    }

    case "/endless-plain": {
      response.writeHead(403, { "content-type": "text/plain" });
      response.write("x".repeat(previewBytes + 1024));

      return;
    }

    case "/missing-type": {
      response.writeHead(200).end(html);

      return;
    }

    case "/empty": {
      response.writeHead(204).end();

      return;
    }

    case "/empty-html": {
      response.writeHead(204, { "content-type": "text/html" }).end();

      return;
    }

    case "/disconnect": {
      request.socket.destroy();

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
      response
        .writeHead(status, {
          "Content-Type": "text/html; charset=utf-8",
          "Set-Cookie": cookies,
          "X-Source": "document",
        })
        .end(html);
    }
  }
};

describe(XrioClient, () => {
  let server: FixtureServer;
  let origin: string;

  beforeAll(async () => {
    server = await startFixtureServer(routes);
    ({ origin } = server);
  });

  afterAll(async () => {
    await server[Symbol.asyncDispose]();
  });

  it.each(["html", "markdown", "json"] as const)(
    "returns the shared result fields and final response headers for %s",
    async (format) => {
      const result = await new XrioClient().scrape({ format, url: `${origin}/redirect` });

      expect(Object.keys(result).toSorted()).toStrictEqual([
        "cookies",
        "data",
        "format",
        "headers",
        "status",
        "url",
      ]);
      expect(result).toMatchObject({
        cookies,
        format,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-source": "document",
        },
        status: 200,
        url: `${origin}/pages/document`,
      });
      expect(result.headers).not.toHaveProperty("set-cookie");
      expect(result.headers).not.toHaveProperty("X-Source");
    },
  );

  it("preserves HTML and shares body-wide Markdown with JSON after redirects", async () => {
    const client = new XrioClient();
    const url = `${origin}/redirect`;
    const source = await client.scrape({ format: "html", url });
    const markdown = await client.scrape({ format: "markdown", url });
    const page = await client.scrape({ format: "json", url });

    expect(source.data).toBe(html);
    expect(page.data.content.markdown).toBe(markdown.data);
    expect(page.data.metadata).toStrictEqual({
      description: "A test page",
      language: "en",
      title: "Head title & metadata",
      url: `${origin}/pages/document`,
    });
    expect(page.data.content.links).toStrictEqual([
      { href: `${origin}/navigation`, text: "Navigation" },
      { href: `${origin}/docs/tea`, text: "Tea" },
      { href: `${origin}/docs/tea`, text: "Tea again" },
      { href: `${origin}/docs/#details`, text: "Details" },
      { href: `${origin}/docs/help`, text: "Help" },
      { href: `${origin}/docs/hidden`, text: "Template link" },
      { href: `${origin}/docs/contact`, text: "Contact" },
    ]);
    expect(page.data.content.images).toStrictEqual([
      { alt: "Tea photo", src: `${origin}/docs/tea.png` },
      { alt: "Tea photo again", src: `${origin}/docs/tea.png` },
      { alt: "", src: `${origin}/docs/hidden.png` },
    ]);
  });

  it("converts the whole body while excluding document-head content", async () => {
    const page = await new XrioClient().scrape({ format: "json", url: `${origin}/redirect` });
    const { markdown, text } = page.data.content;

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

    expect(page.data).toStrictEqual({
      content: { images: [], links: [], markdown: "Body only", text: "Body only" },
      metadata: { description: null, language: null, title: null, url: `${origin}/fragment` },
    });
    expect(titled.data.metadata.title).toBe("Title");
    expect(titled.data.content.markdown).toBe("Body only");
    expect(titled.data.content.text).toBe("Body only");
    expect(page.cookies).toStrictEqual([]);
  });

  it("keeps mode overrides local to one call and rejects browser modes", async () => {
    const client = new XrioClient({ browserPath: "/browser", mode: "headed" });
    const url = `${origin}/fragment`;

    await expect(client.scrape({ format: "html", url })).rejects.toMatchObject({
      code: "MODE_NOT_IMPLEMENTED",
      message: "The headed mode is not implemented.",
      name: "XrioError",
    });
    await expect(client.scrape({ format: "html", mode: "http", url })).resolves.toMatchObject({
      data: "<p>Body only</p>",
      format: "html",
      status: 200,
      url,
    });
    await expect(client.scrape({ format: "html", url })).rejects.toMatchObject({
      code: "MODE_NOT_IMPLEMENTED",
      message: "The headed mode is not implemented.",
    });
    await expect(
      new XrioClient().scrape({ browserPath: "/browser", format: "json", mode: "headless", url }),
    ).rejects.toMatchObject({
      code: "MODE_NOT_IMPLEMENTED",
      message: "The headless mode is not implemented.",
      name: "XrioError",
    });
  });

  it.each([202, 403, 404, 500])(
    "returns HTML responses with HTTP %s in every format",
    async (status) => {
      const client = new XrioClient();
      const url = `${origin}/pages/document?status=${status}`;

      const [source, markdown, page] = await Promise.all([
        client.scrape({ format: "html", url }),
        client.scrape({ format: "markdown", url }),
        client.scrape({ format: "json", url }),
      ]);

      for (const result of [source, markdown, page]) {
        expect(result).toMatchObject({ cookies, status, url });
        expect(result).not.toHaveProperty("error");
      }

      expect(source.data).toBe(html);
      expect(markdown.data).toContain("# Catalog");
      expect(page.data.content.markdown).toBe(markdown.data);
    },
  );

  it.each([
    { body: "Not HTML", path: "/plain", status: 200 },
    { body: "{}", path: "/json?status=403", status: 403 },
    { body: html, path: "/missing-type", status: 200 },
    { body: "", path: "/empty", status: 204 },
    { body: "", path: "/empty-html", status: 204 },
    { body: "x".repeat(previewBytes), path: "/endless-plain", status: 403 },
  ])(
    "rejects unsupported content from $path with response details",
    async ({ body, path, status }) => {
      await expect(
        new XrioClient().scrape({ format: "json", url: `${origin}${path}` }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_CONTENT_TYPE",
        details: { body, status, url: `${origin}${path}` },
        name: "XrioError",
      });
    },
  );

  it("preserves response headers and cookies on unsupported-content errors", async () => {
    const rejection = new XrioClient().scrape({ format: "html", url: `${origin}/json` });

    await expect(rejection).rejects.toMatchObject({
      details: { cookies, headers: { "content-type": "application/json" } },
    });
    await expect(rejection).rejects.not.toHaveProperty(["details", "headers", "set-cookie"]);
  });

  it("validates URLs before fetching", async () => {
    const client = new XrioClient();

    await expect(
      client.scrape({ format: "html", url: "file:///tmp/page.html" }),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      name: "TypeError",
    });
    await expect(client.scrape({ format: "html", url: "relative/path" })).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      name: "TypeError",
    });

    const withCredentials = client.scrape({
      format: "html",
      url: "https://user:secret@xrio.invalid/",
    });

    await expect(withCredentials).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(withCredentials).rejects.toSatisfy(
      (error) => !inspect(error, { depth: Number.POSITIVE_INFINITY }).includes("secret"),
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid timeout %s",
    async (timeoutMs) => {
      await expect(
        new XrioClient().scrape({ format: "html", timeoutMs, url: origin }),
      ).rejects.toMatchObject({ code: "INVALID_OPTIONS", name: "TypeError" });
    },
  );

  it("allows callers to abort before fetching or during a request", async () => {
    const client = new XrioClient();
    const controller = new AbortController();
    onRequest = () => {
      controller.abort();
    };

    const pending = client.scrape({
      format: "html",
      signal: controller.signal,
      url: `${origin}/slow`,
    });

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      client.scrape({ format: "html", signal: controller.signal, url: origin }),
    ).rejects.toMatchObject({ name: "AbortError" });
    const reason = new Error("Stopped by caller");

    await expect(
      client.scrape({ format: "html", signal: AbortSignal.abort(reason), url: origin }),
    ).rejects.toBe(reason);
    await expect(
      client.scrape({ format: "html", url: `${origin}/fragment` }),
    ).resolves.toMatchObject({
      data: "<p>Body only</p>",
    });
  });
});

describe("XrioClient errors", () => {
  let server: FixtureServer;
  let origin: string;

  beforeAll(async () => {
    server = await startFixtureServer(routes);
    ({ origin } = server);
  });

  afterAll(async () => {
    await server[Symbol.asyncDispose]();
  });

  it.each(["/waiting", "/slow"])(
    "rejects with TIMEOUT when the deadline passes while loading %s",
    async (path) => {
      const rejection = new XrioClient().scrape({
        format: "html",
        timeoutMs: 100,
        url: `${origin}${path}`,
      });

      await expect(rejection).rejects.toBeInstanceOf(XrioError);
      await expect(rejection).rejects.toMatchObject({ code: "TIMEOUT", name: "XrioError" });
    },
  );

  it("maps a dropped connection to NETWORK_ERROR and keeps the client error as the cause", async () => {
    await expect(
      new XrioClient().scrape({ format: "html", url: `${origin}/disconnect` }),
    ).rejects.toMatchObject({
      cause: { name: "RequestError" },
      code: "NETWORK_ERROR",
      name: "XrioError",
    });
  });

  it("refuses a proxy in http mode until it can be used, without echoing its credentials", async () => {
    const rejection = new XrioClient({ proxy: "http://user:secret@proxy.test:8000" }).scrape({
      format: "html",
      url: origin,
    });

    await expect(rejection).rejects.toMatchObject({ code: "INVALID_OPTIONS", name: "TypeError" });
    await expect(rejection).rejects.toSatisfy(
      (error) => !inspect(error, { depth: Number.POSITIVE_INFINITY }).includes("secret"),
    );
  });

  it("rejects with errors that isXrioError recognizes by code", async () => {
    const client = new XrioClient();

    await expect(client.scrape({ format: "html", url: `${origin}/plain` })).rejects.toSatisfy(
      (error) => isXrioError(error, "UNSUPPORTED_CONTENT_TYPE"),
    );
    await expect(client.scrape({ format: "html", url: "ftp://xrio.invalid" })).rejects.toSatisfy(
      (error) => isXrioError(error, "INVALID_OPTIONS"),
    );
  });
});
