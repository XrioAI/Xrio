import { Xrio, XrioError, definePlugin } from "@xrio/core";
import type { Engine } from "@xrio/core";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { httpApiPlugin } from "./index.ts";
import type { HttpApiOptions, HttpApiPlugin } from "./index.ts";

const engine: Engine = {
  fetch: async () =>
    await Promise.resolve({ finalUrl: "https://example.com/", html: "<p>x</p>", status: 200 }),
  mode: "headless",
};

const browser = definePlugin({ engines: [engine], hooks: {}, name: "browser" });

const brokenEngine: Engine = {
  fetch: async (request) =>
    await Promise.reject(
      request.url.includes("plain")
        ? new Error("kaboom")
        : new XrioError("fetch_failed", "target unreachable"),
    ),
  mode: "headful",
};

const broken = definePlugin({ engines: [brokenEngine], hooks: {}, name: "broken" });

describe(httpApiPlugin, () => {
  const running: Xrio[] = [];

  const serve = async (options: HttpApiOptions = {}): Promise<HttpApiPlugin> => {
    const api = httpApiPlugin({ host: "127.0.0.1", port: 0, ...options });

    const xrio = Xrio.create({ log: { enabled: false } })
      .use(browser)
      .use(broken)
      .use(api);

    await xrio.start();
    running.push(xrio);

    return api;
  };

  afterEach(async () => {
    await Promise.all(
      running.splice(0).map(async (xrio) => {
        await xrio.stop();
      }),
    );
  });

  it("declares only the lifecycle steps", () => {
    const xrio = Xrio.create({ log: { enabled: false } }).use(httpApiPlugin({ port: 0 }));

    expect(xrio.plugins).toStrictEqual([{ name: "http-api", steps: ["start", "stop"] }]);
  });

  it("has no address until Xrio starts, and none again after it stops", async () => {
    const api = httpApiPlugin({ host: "127.0.0.1", port: 0 });

    const xrio = Xrio.create({ log: { enabled: false } })
      .use(browser)
      .use(api);

    expect(api.url).toBeUndefined();

    await xrio.start();
    const whileRunning = api.url;
    await xrio.stop();

    expect(whileRunning).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(api.url).toBeUndefined();
    expect(api.docsUrl).toBeUndefined();
  });

  it("rejects ports that cannot work", () => {
    expect(() => httpApiPlugin({ port: 70_000 })).toThrow(/"port"/u);
    expect(() => httpApiPlugin({ port: 1.5 })).toThrow(/"port"/u);
    expect(() => httpApiPlugin({ port: -1 })).toThrow(/"port"/u);
  });

  it("serves the Swagger UI and OpenAPI document by default", async () => {
    const api = await serve();

    const ui = await fetch(`${api.url}/docs/`);
    const document = await fetch(`${api.url}/docs.json`);

    expect(ui.status).toBe(200);
    await expect(ui.text()).resolves.toContain("swagger-ui");
    await expect(document.json()).resolves.toMatchObject({
      info: { title: "Xrio API" },
      paths: { "/scrape": { post: { summary: "Scrape a URL" } } },
    });
    expect(api.docsUrl).toBe(`${api.url}/docs`);
  });

  it("does not serve docs when docs is false", async () => {
    const api = await serve({ docs: false });

    const ui = await fetch(`${api.url}/docs/`);
    const document = await fetch(`${api.url}/docs.json`);

    expect(ui.status).toBe(404);
    expect(document.status).toBe(404);
    expect(api.docsUrl).toBeUndefined();
  });

  it("scrapes over HTTP in the requested format", async () => {
    const api = await serve();

    const response = await fetch(`${api.url}/scrape`, {
      body: JSON.stringify({ format: "json", mode: "headless", url: "https://example.com/" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ html: "<p>x</p>", status: 200 });
  });

  it("rejects bad bodies with a JSON 400 and unsupported formats with a 501", async () => {
    const api = await serve();
    const endpoint = `${api.url}/scrape`;

    const malformed = await fetch(endpoint, { body: "{", method: "POST" });
    const invalid = await fetch(endpoint, { body: '{"url":"nope"}', method: "POST" });

    const unsupported = await fetch(endpoint, {
      body: '{"url":"https://example.com","format":"md"}',
      method: "POST",
    });

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(unsupported.status).toBe(501);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });

  it("answers the wrong method with 405 and unknown paths with 404", async () => {
    const api = await serve();

    const wrongMethod = await fetch(`${api.url}/scrape`);
    const wrongPath = await fetch(`${api.url}/other`, { method: "POST" });

    expect(wrongMethod.status).toBe(405);
    expect(wrongPath.status).toBe(404);
  });

  it("hides unexpected failures behind a generic 500", async () => {
    const api = await serve();

    const response = await fetch(`${api.url}/scrape`, {
      body: JSON.stringify({ mode: "headful", url: "https://example.com/plain" }),
      method: "POST",
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: { code: "internal_error", message: "Internal error." },
    });
  });

  it("maps a failed fetch to 502 with its own code", async () => {
    const api = await serve();

    const response = await fetch(`${api.url}/scrape`, {
      body: JSON.stringify({ mode: "headful", url: "https://example.com/down" }),
      method: "POST",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "fetch_failed" } });
  });

  it("rejects a body over the size limit with 413", async () => {
    const api = await serve();

    const response = await fetch(`${api.url}/scrape`, {
      body: JSON.stringify({ padding: "x".repeat(1_100_000), url: "https://example.com" }),
      method: "POST",
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
  });
});
