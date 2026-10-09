import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "./client.ts";
import { chromePath } from "./testing/chrome-path.ts";
import { startFixtureServer } from "./testing/fixture-server.ts";

const isCookieSkip = (message: unknown): message is { event: "cookie-skipped"; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "cookie-skipped" &&
  "detail" in message &&
  typeof message.detail === "string";

describe("request controls", () => {
  it("seeds browser cookies before navigation while Chrome enforces HttpOnly and path scope", async () => {
    const received: (string | undefined)[] = [];

    await using server = await startFixtureServer((request, response) => {
      received.push(request.headers.cookie);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        '<!doctype html><html><body><output id="cookies"></output><script>document.getElementById("cookies").textContent = document.cookie;</script></body></html>',
      );
    });

    await using client = new XrioClient({ browserPath: chromePath(), mode: "headless" });

    const result = await client.scrape({
      cookies: [
        "visible=one; Path=/; SameSite=Lax",
        "hidden=two; Path=/; HttpOnly; SameSite=Strict",
        "domain=three; Domain=127.0.0.1; Path=/; HttpOnly",
        "elsewhere=three; Path=/elsewhere",
        "expired=four; Path=/; Max-Age=0",
      ],
      format: "html",
      url: `${server.origin}/page`,
    });

    expect(received[0]?.split("; ")).toStrictEqual(
      expect.arrayContaining(["visible=one", "hidden=two", "domain=three"]),
    );
    expect(received[0]).not.toContain("elsewhere=three");
    expect(received[0]).not.toContain("expired=four");
    expect(result.data).toContain('<output id="cookies">visible=one</output>');
  });

  it("seeds prefixed, maximum-size, and host-equal public-suffix cookies into Chrome", async () => {
    const received: (string | undefined)[] = [];
    const name = "n".repeat(4000);
    const value = "v".repeat(96);

    await using server = await startFixtureServer((request, response) => {
      received.push(request.headers.cookie);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<p>seeded</p>");
    });

    await using client = new XrioClient({ browserPath: chromePath(), mode: "headless" });

    const result = await client.scrape({
      cookies: [
        "__Host-a=1; Secure; Path=/",
        "__Http-b=2; Secure; HttpOnly; Path=/",
        "__Host-Http-c=3; Secure; HttpOnly",
        "__secure-d=4; Secure; Path=/",
        `${name}=${value}; Path=/`,
        "suffix=6; Domain=localhost; Path=/",
      ],
      format: "html",
      url: `${server.crossOrigin}/`,
    });

    expect(result.data).toContain("<p>seeded</p>");
    expect(received[0]?.split("; ").toSorted()).toStrictEqual([
      "__Host-Http-c=3",
      "__Host-a=1",
      "__Http-b=2",
      "__secure-d=4",
      `${name}=${value}`,
      "suffix=6",
    ]);
  });

  it("keeps a seed whose public-suffix Domain is the target host on that host only", async () => {
    const received: string[] = [];

    await using server = await startFixtureServer((request, response, origins) => {
      if (request.url === "/start" || request.url === "/sub") {
        received.push(`${request.url} ${request.headers.cookie ?? "-"}`);
      }

      if (request.url === "/start") {
        const subdomain = origins.crossOrigin.replace("//localhost", "//sub.localhost");

        response.writeHead(302, { Location: `${subdomain}/sub` });
        response.end();

        return;
      }

      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<p>done</p>");
    });

    await using client = new XrioClient({ browserPath: chromePath(), mode: "headless" });
    await client.scrape({
      cookies: ["suffix=one; Domain=localhost; Path=/"],
      format: "html",
      url: `${server.crossOrigin}/start`,
    });

    expect(received).toStrictEqual(["/start suffix=one", "/sub -"]);
  });

  it("skips a seed Chrome refuses beyond the known rules, reports it, and keeps the rest", async () => {
    const received: (string | undefined)[] = [];
    const skips: string[] = [];

    const recordSkip: ChannelListener = (message) => {
      if (isCookieSkip(message)) {
        skips.push(message.detail);
      }
    };

    await using server = await startFixtureServer((request, response) => {
      if (request.url === "/") {
        received.push(request.headers.cookie);
      }

      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<p>seeded</p>");
    });

    await using client = new XrioClient({ browserPath: chromePath(), mode: "headless" });

    subscribe("xrio:event", recordSkip);

    try {
      await client.scrape({
        cookies: ["good=one; Path=/", `accented=two; Path=/${"é".repeat(300)}`],
        format: "html",
        url: `${server.origin}/`,
      });
    } finally {
      unsubscribe("xrio:event", recordSkip);
    }

    expect({ received, skips }).toStrictEqual({
      received: ["good=one"],
      skips: ['{"name":"accented","reason":"refused-by-chrome"}'],
    });
  });

  it("starts a relative cookie lifetime when a queued scrape reaches Chrome", async () => {
    const started = Promise.withResolvers<"started">();
    const received: (string | undefined)[] = [];

    await using server = await startFixtureServer((request, response) => {
      if (request.url === "/fresh") {
        received.push(request.headers.cookie);
      }

      response.writeHead(200, { "Content-Type": "text/html" });

      if (request.url === "/slow") {
        started.resolve("started");
        void delay(1200).then(() => {
          response.end("<p>first</p>");
        });

        return;
      }

      response.end("<p>second</p>");
    });

    await using client = new XrioClient({
      browserPath: chromePath(),
      maxBrowsers: 1,
      mode: "headless",
    });

    const first = client.scrape({ format: "html", url: `${server.origin}/slow` });

    await started.promise;

    const second = client.scrape({
      cookies: ["fresh=one; Path=/; Max-Age=1"],
      format: "html",
      url: `${server.origin}/fresh`,
    });

    await Promise.all([first, second]);
    expect(received).toStrictEqual(["fresh=one"]);
  });
});
