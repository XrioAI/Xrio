import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { inspect } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { isXrioError, XrioClient, XrioError } from "./client.ts";
import type { IdentityReport } from "./client.ts";
import { scratchRoot } from "./sources/browser/browser-process.ts";
import { fakeChromePath } from "./testing/fake-chrome-path.ts";
import { dumpsRun, fakeForkPath, hangDumpFor } from "./testing/fake-fork.ts";
import { startFakeHttpProxy } from "./testing/fake-proxies.ts";
import { startFixtureServer } from "./testing/fixture-server.ts";
import type { FixtureServer } from "./testing/fixture-server.ts";
import { stageTimeline } from "./testing/stage-timeline.ts";

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

const CAPTURE_BEFORE_TEARDOWN_MS = 1500;

const ABORT_DURING_LAUNCH_MS = 200;

const LAUNCH_TIMEOUT_MS = 500;

const HOST_FACTS_FILE = /^host-facts-[\da-f]+\.json$/u;

const storedFactsIn = async (directory: string): Promise<string[]> => {
  try {
    const names = await readdir(directory);

    return names.filter((name) => HOST_FACTS_FILE.test(name));
  } catch {
    return [];
  }
};

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
      const result = await new XrioClient({ mode: "http" }).scrape({
        format,
        url: `${origin}/redirect`,
      });

      expect(Object.keys(result).toSorted()).toStrictEqual([
        "block",
        "cookies",
        "data",
        "format",
        "headers",
        "identity",
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
        identity: {
          coverage: { requestHeaders: { reason: "no-request-log", state: "unchecked" } },
          locale: "en-US",
          mode: "http",
          profile: { chromeMajor: 149, platform: "linux" },
          tells: [],
        },
        status: 200,
        url: `${origin}/pages/document`,
      });
      expect(result.headers).not.toHaveProperty("set-cookie");
      expect(result.headers).not.toHaveProperty("X-Source");
    },
  );

  it("preserves HTML and shares body-wide Markdown with JSON after redirects", async () => {
    const client = new XrioClient({ mode: "http" });
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
    const page = await new XrioClient({ mode: "http" }).scrape({
      format: "json",
      url: `${origin}/redirect`,
    });

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
    const client = new XrioClient({ mode: "http" });
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

  it("keeps mode overrides local to one call", async () => {
    const client = new XrioClient({ browserPath: "/nonexistent/chrome" });
    const url = `${origin}/fragment`;

    await expect(client.scrape({ format: "html", url })).rejects.toMatchObject({
      code: "BROWSER_LAUNCH_FAILED",
      name: "XrioError",
    });
    await expect(client.scrape({ format: "html", mode: "http", url })).resolves.toMatchObject({
      data: "<p>Body only</p>",
      format: "html",
      status: 200,
      url,
    });
    await expect(client.scrape({ format: "html", url })).rejects.toMatchObject({
      code: "BROWSER_LAUNCH_FAILED",
    });
  });

  it("rejects scrapes once the client is closed", async () => {
    const client = new XrioClient({ mode: "http" });

    await client.close();

    await expect(client.scrape({ format: "html", url: origin })).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
      message: "The client is closed.",
      name: "XrioError",
    });
  });

  it("closes when disposed", async () => {
    let disposed: XrioClient;

    {
      await using client = new XrioClient({ mode: "http" });
      disposed = client;
    }

    await expect(disposed.scrape({ format: "html", url: origin })).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
  });

  it.each([202, 403, 404, 500])(
    "returns HTML responses with HTTP %s in every format",
    async (status) => {
      const client = new XrioClient({ mode: "http" });
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
        new XrioClient({ mode: "http" }).scrape({ format: "json", url: `${origin}${path}` }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_CONTENT_TYPE",
        details: { body, status, url: `${origin}${path}` },
        name: "XrioError",
      });
    },
  );

  it("preserves response headers and cookies on unsupported-content errors", async () => {
    const rejection = new XrioClient({ mode: "http" }).scrape({
      format: "html",
      url: `${origin}/json`,
    });

    await expect(rejection).rejects.toMatchObject({
      details: { cookies, headers: { "content-type": "application/json" } },
    });
    await expect(rejection).rejects.not.toHaveProperty(["details", "headers", "set-cookie"]);
  });

  it("validates URLs before fetching", async () => {
    const client = new XrioClient({ mode: "http" });

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
        new XrioClient({ mode: "http" }).scrape({ format: "html", timeoutMs, url: origin }),
      ).rejects.toMatchObject({ code: "INVALID_OPTIONS", name: "TypeError" });
    },
  );

  it("allows callers to abort before fetching or during a request", async () => {
    const client = new XrioClient({ mode: "http" });
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
      const rejection = new XrioClient({ mode: "http" }).scrape({
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
      new XrioClient({ mode: "http" }).scrape({ format: "html", url: `${origin}/disconnect` }),
    ).rejects.toMatchObject({
      cause: { name: "RequestError" },
      code: "NETWORK_ERROR",
      name: "XrioError",
    });
  });

  it("rejects with errors that isXrioError recognizes by code", async () => {
    const client = new XrioClient({ mode: "http" });

    await expect(client.scrape({ format: "html", url: `${origin}/plain` })).rejects.toSatisfy(
      (error) => isXrioError(error, "UNSUPPORTED_CONTENT_TYPE"),
    );
    await expect(client.scrape({ format: "html", url: "ftp://xrio.invalid" })).rejects.toSatisfy(
      (error) => isXrioError(error, "INVALID_OPTIONS"),
    );
  });
});

const fullDepth = (value: IdentityReport | XrioError): string =>
  inspect(value, { depth: Number.POSITIVE_INFINITY });

describe("the identity report's secrets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("holds no proxy credential or relay token in an http scrape through a proxy", async () => {
    await using fixture = await startFixtureServer(routes);
    const fixturePort = Number(new URL(fixture.origin).port);

    await using proxy = await startFakeHttpProxy({
      requireCredentials: "user:secret",
      tunnelTo: fixturePort,
    });

    const client = new XrioClient({
      mode: "http",
      proxy: proxy.url.replace("://", "://user:secret@"),
    });

    const { identity } = await client.scrape({ format: "html", url: "http://origin.test/" });

    expect(fullDepth(identity)).not.toMatch(/secret|xrio:|127\.0\.0\.1/u);
  });

  it("holds no scratch path in a browser report or a launch error", async () => {
    const root = scratchRoot();

    vi.stubEnv("TZ", "America/Chicago");

    await using client = new XrioClient({
      browserPath: await fakeChromePath("normal"),
      mode: "headless",
    });

    const { identity } = await client.scrape({ format: "html", url: "https://fake.test/page" });

    await using drifted = new XrioClient({
      browserPath: await fakeChromePath("identity-drift"),
      mode: "headless",
    });

    expect({ leaked: fullDepth(identity).includes(root), mode: identity.mode }).toStrictEqual({
      leaked: false,
      mode: "headless",
    });
    await expect(
      drifted.scrape({ format: "html", url: "https://fake.test/page" }),
    ).rejects.toSatisfy(
      (error) =>
        isXrioError(error, "BROWSER_LAUNCH_FAILED") &&
        error.details.mismatches.length === 1 &&
        !fullDepth(error).includes(root),
    );
  });
});

describe("XrioClient browser lifecycle", () => {
  it("returns a capture that finished in time even when teardown runs past the deadline", async () => {
    await using client = new XrioClient({
      browserPath: await fakeChromePath("ignore-close"),
      mode: "headless",
    });

    await expect(
      client.scrape({
        format: "html",
        timeoutMs: CAPTURE_BEFORE_TEARDOWN_MS,
        url: "https://fake.test/page",
      }),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe("XrioClient browser admission", () => {
  it("rejects queued work on close without another Chrome launch and waits for running cleanup", async () => {
    using stages = stageTimeline(new Set(["launch", "teardown"]));

    await stages.recording(async () => {
      const client = new XrioClient({
        browserPath: await fakeChromePath("ignore-close"),
        maxBrowsers: 1,
        mode: "headless",
      });

      try {
        await expect(
          client.scrape({ format: "html", url: "https://fake.test/page" }),
        ).resolves.toMatchObject({ status: 200 });
        const queued = client.scrape({ format: "html", url: "https://fake.test/queued" });
        const closed = client.close();

        await expect(queued).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
        expect(stages.timeline).toStrictEqual(["launch"]);
        await closed;
        expect(stages.timeline).toStrictEqual(["launch", "teardown"]);
      } finally {
        await client.close();
      }
    });
  });

  it("sweeps no browser scratch for http scrapes, refused scrapes or a closed client", async () => {
    await using fixture = await startFixtureServer(routes);
    using stages = stageTimeline(new Set(["scratch-sweep"]));

    await stages.recording(async () => {
      const http = new XrioClient({ mode: "http" });

      await expect(
        http.scrape({ format: "html", url: `${fixture.origin}/pages/document` }),
      ).resolves.toMatchObject({ status: 200 });
      await http.close();

      const browser = new XrioClient({
        browserPath: await fakeChromePath("normal"),
        mode: "headless",
      });

      await expect(browser.scrape({ format: "html", url: "relative/path" })).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
      });
      await browser.close();
      await expect(browser.scrape({ format: "html", url: fixture.origin })).rejects.toMatchObject({
        code: "CLIENT_CLOSED",
      });
    });

    expect(stages.timeline).toStrictEqual([]);
  });

  it("sweeps abandoned scratch once, before the first browser launch", async () => {
    using stages = stageTimeline(new Set(["scratch-sweep", "launch"]));

    await stages.recording(async () => {
      await using client = new XrioClient({
        browserPath: await fakeChromePath("normal"),
        mode: "headless",
      });

      await client.scrape({ format: "html", url: "https://fake.test/page" });
      await client.scrape({ format: "html", url: "https://fake.test/page" });
    });

    expect(stages.timeline).toStrictEqual(["scratch-sweep", "launch", "launch"]);
  });

  it("starts a queued scrape only after the previous visit has closed", async () => {
    using stages = stageTimeline(new Set(["launch", "teardown"]));

    await stages.recording(async () => {
      await using client = new XrioClient({
        browserPath: await fakeChromePath("normal"),
        maxBrowsers: 1,
        mode: "headless",
      });

      const scrapeAndMark = async (name: string) => {
        await client.scrape({ format: "html", url: "https://fake.test/page" });
        stages.mark(`${name} resolved`);
      };

      await Promise.all([scrapeAndMark("first"), scrapeAndMark("second")]);
    });

    expect(stages.timeline).toStrictEqual([
      "launch",
      "first resolved",
      "teardown",
      "launch",
      "second resolved",
      "teardown",
    ]);
  });

  it.each([
    { error: { code: "BROWSER_LAUNCH_FAILED" }, scenario: "no-start" },
    { error: { code: "BROWSER_CRASHED" }, scenario: "crash-on-navigate" },
    { error: { code: "NETWORK_ERROR" }, scenario: "navigate-error" },
    {
      abortAfterMs: ABORT_DURING_LAUNCH_MS,
      error: { name: "TimeoutError" },
      scenario: "slow-start",
    },
    { error: { code: "TIMEOUT" }, scenario: "slow-start", timeoutMs: LAUNCH_TIMEOUT_MS },
  ])(
    "admits the next scrape after $scenario rejects with $error",
    async ({ abortAfterMs, error, scenario, timeoutMs }) => {
      await using client = new XrioClient({
        browserPath: await fakeChromePath("normal"),
        maxBrowsers: 1,
        mode: "headless",
      });

      const failing = client.scrape({
        browserPath: await fakeChromePath(scenario),
        format: "html",
        mode: "headless",
        signal: abortAfterMs === undefined ? undefined : AbortSignal.timeout(abortAfterMs),
        timeoutMs,
        url: "https://fake.test/page",
      });

      await expect(failing).rejects.toMatchObject(error);
      await expect(
        client.scrape({ format: "html", timeoutMs: 10_000, url: "https://fake.test/page" }),
      ).resolves.toMatchObject({ status: 200 });
    },
  );
});

describe("the client's host facts", () => {
  it("starts no probe when constructed or closed without scraping", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "xrio-client-fork-"));

    try {
      const browserPath = await fakeForkPath("kit", { root });

      const client = new XrioClient({
        browserPath,
        cacheDir: nodePath.join(root, "cache"),
        mode: "headless",
      });

      await client.close();
      await expect(dumpsRun(browserPath)).resolves.toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("shares one probe across clients, and each http scrape compares its client's binary", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "xrio-client-fork-"));

    try {
      await using fixture = await startFixtureServer(routes);
      const browserPath = await fakeForkPath("kit", { root });

      const comparisonPath = await fakeForkPath("kit", {
        root: nodePath.join(root, "comparison"),
        version: "149.0.7800.10",
      });

      const cacheDir = nodePath.join(root, "cache");
      await using first = new XrioClient({ browserPath, cacheDir, mode: "headless" });
      await using second = new XrioClient({ browserPath, cacheDir, mode: "headless" });

      await using older = new XrioClient({
        browserPath: comparisonPath,
        cacheDir,
        mode: "headless",
      });

      const request = {
        format: "html",
        mode: "http",
        url: `${fixture.origin}/pages/document`,
      } as const;

      const pages = await Promise.all([
        first.scrape(request),
        second.scrape(request),
        older.scrape(request),
      ]);

      expect(pages.map((page) => page.identity.tells)).toStrictEqual([
        ["http-profile-skew"],
        ["http-profile-skew"],
        [],
      ]);
      await expect(dumpsRun(browserPath)).resolves.toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("awaits a slow comparison probe under the http deadline, so timing cannot hide skew", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "xrio-client-fork-"));

    try {
      await using fixture = await startFixtureServer(routes);
      const browserPath = await fakeForkPath("kit", { root });

      await hangDumpFor(browserPath, 0.5);

      await using client = new XrioClient({
        browserPath,
        cacheDir: nodePath.join(root, "cache"),
        mode: "headless",
      });

      const page = await client.scrape({
        format: "html",
        mode: "http",
        timeoutMs: 5000,
        url: `${fixture.origin}/pages/document`,
      });

      expect(page.identity).toMatchObject({
        coverage: { httpProfileSkew: { state: "observed" } },
        mode: "http",
        tells: ["http-profile-skew"],
      });
      await expect(dumpsRun(browserPath)).resolves.toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports the comparison unchecked for an http client without a binary", async () => {
    await using fixture = await startFixtureServer(routes);
    await using client = new XrioClient({ mode: "http" });
    const page = await client.scrape({ format: "html", url: `${fixture.origin}/pages/document` });

    expect(page.identity).toMatchObject({
      coverage: { httpProfileSkew: { reason: "not-observed", state: "unchecked" } },
      mode: "http",
      tells: [],
    });
  });

  it("answers at the deadline mid-probe, and closes only once the probe is gone", async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "xrio-client-fork-"));

    try {
      const browserPath = await fakeForkPath("kit", { root });
      const cacheDir = nodePath.join(root, "cache");

      await hangDumpFor(browserPath, 0.5);

      const client = new XrioClient({ browserPath, cacheDir, mode: "headless" });

      await expect(
        client.scrape({ format: "html", timeoutMs: 100, url: "http://127.0.0.1:9/" }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      await expect(storedFactsIn(nodePath.join(cacheDir, "host"))).resolves.toStrictEqual([]);

      await client.close();

      await expect(storedFactsIn(nodePath.join(cacheDir, "host"))).resolves.toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
