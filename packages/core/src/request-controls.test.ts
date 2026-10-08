import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "./client.ts";
import { resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { startFixtureServer } from "./testing/fixture-server.ts";

const page = { format: "html", url: "https://example.com" } as const;

const http = resolveClientOptions({ mode: "http" });

const isCookieSkip = (
  message: unknown,
): message is { event: "cookie-skipped"; detail: string; scrapeId: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "cookie-skipped" &&
  "detail" in message &&
  typeof message.detail === "string" &&
  "scrapeId" in message &&
  typeof message.scrapeId === "string";

describe("request controls", () => {
  it("rejects headers in inherited browser mode and profile-owned HTTP headers", () => {
    const browser = resolveClientOptions({ browserPath: "/chrome", mode: "headless" });

    expect(() =>
      resolveScrapeIntent({ ...page, headers: { Authorization: "secret" }, mode: "http" }, browser),
    ).not.toThrow();
    expect(() =>
      // @ts-expect-error JavaScript callers can pass HTTP controls to browser mode.
      resolveScrapeIntent({ ...page, headers: { Authorization: "secret" } }, browser),
    ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS" }));

    for (const name of ["User-Agent", "ACCEPT-LANGUAGE", "Sec-CH-UA", "sec-ch-ua-platform"]) {
      expect(() =>
        resolveScrapeIntent({ ...page, headers: { [name]: "override" }, mode: "http" }, http),
      ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS" }));
    }

    expect(() =>
      resolveScrapeIntent(
        { ...page, headers: { "x-key": "secret\r\ninjected: yes" }, mode: "http" },
        http,
      ),
    ).toThrow(expect.objectContaining({ code: "INVALID_OPTIONS" }));
  });

  it("rejects a caller Cookie header and points to the cookies option", () => {
    for (const name of ["Cookie", "cookie"]) {
      expect(() =>
        resolveScrapeIntent({ ...page, headers: { [name]: "manual=2" }, mode: "http" }, http),
      ).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: "cookie is owned by the cookies option.",
        }),
      );
    }
  });

  describe("HTTP request controls", () => {
    it("keeps profile header order while replacing an existing header and appending a custom one", async () => {
      const received: string[][] = [];

      await using server = await startFixtureServer((request, response) => {
        received.push(
          request.rawHeaders
            .filter((_value, index) => index % 2 === 0)
            .map((name) => name.toLowerCase()),
        );
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(
          `<p>${request.headers.accept ?? ""}|${String(request.headers["x-request"] ?? "")}</p>`,
        );
      });

      await using client = new XrioClient({ mode: "http" });
      await client.scrape({ format: "html", url: server.origin });

      const result = await client.scrape({
        format: "html",
        headers: { Accept: "text/html", "X-Request": "custom" },
        mode: "http",
        url: server.origin,
      });

      expect(result.data).toBe("<p>text/html|custom</p>");
      expect(received[1]?.filter((name) => name !== "x-request")).toStrictEqual(received[0]);
      expect(received[1]?.at(-1)).toBe("x-request");
    });

    it("sends valid prototype-like header names without mutating the normalized record", async () => {
      await using server = await startFixtureServer((request, response) => {
        response.writeHead(200, { "Content-Type": "text/html" });
        const index = request.rawHeaders.indexOf("__proto__");

        response.end(`<p>${index === -1 ? "" : (request.rawHeaders[index + 1] ?? "")}</p>`);
      });

      await using client = new XrioClient({ mode: "http" });

      const result = await client.scrape({
        format: "html",
        headers: Object.fromEntries([["__proto__", "custom"]]),
        mode: "http",
        url: server.origin,
      });

      expect(result.data).toBe("<p>custom</p>");
    });

    it("drops every caller header on a cross-origin hop and never restores them on return", async () => {
      const received: {
        url: string;
        authorization: string | undefined;
        custom: string | string[] | undefined;
        accept: string | undefined;
      }[] = [];

      await using server = await startFixtureServer((request, response, origins) => {
        received.push({
          accept: request.headers.accept,
          authorization: request.headers.authorization,
          custom: request.headers["x-request"],
          url: request.url ?? "",
        });

        const destinations = new Map([
          ["/start", `${origins.origin}/same`],
          ["/same", `${origins.crossOrigin}/away`],
          ["/away", `${origins.origin}/back`],
        ]);

        const location = destinations.get(request.url ?? "");

        if (location !== undefined) {
          response.setHeader("Location", location);
        }

        response.writeHead(location === undefined ? 200 : 302, { "Content-Type": "text/html" });
        response.end("<p>done</p>");
      });

      await using client = new XrioClient({ mode: "http" });
      await client.scrape({
        format: "html",
        headers: { Accept: "application/custom", Authorization: "secret", "X-Request": "custom" },
        mode: "http",
        url: `${server.origin}/start`,
      });

      expect(
        received.map(({ url, authorization, custom }) => ({ authorization, custom, url })),
      ).toStrictEqual([
        { authorization: "secret", custom: "custom", url: "/start" },
        { authorization: "secret", custom: "custom", url: "/same" },
        { authorization: undefined, custom: undefined, url: "/away" },
        { authorization: undefined, custom: undefined, url: "/back" },
      ]);
      expect(received[2]?.accept).not.toBe("application/custom");
      expect(received[3]?.accept).not.toBe("application/custom");
    });

    it("seeds the native jar and applies path, expiry, Secure, and host-only scope across redirects", async () => {
      const received: (string | undefined)[] = [];

      await using server = await startFixtureServer((request, response, origins) => {
        received.push(request.headers.cookie);

        const destinations = new Map([
          ["/only/start", `${origins.origin}/outside`],
          ["/outside", `${origins.crossOrigin}/finish`],
        ]);

        const location = destinations.get(request.url ?? "");

        if (location !== undefined) {
          response.setHeader("Location", location);
        }

        response.writeHead(location === undefined ? 200 : 302, { "Content-Type": "text/html" });
        response.end("<p>done</p>");
      });

      await using client = new XrioClient({ mode: "http" });
      await client.scrape({
        cookies: [
          "host=one; Path=/; HttpOnly; SameSite=Strict",
          "path=two; Path=/outside",
          "secure=three; Path=/; Secure",
          "expired=four; Path=/; Max-Age=0",
        ],
        format: "html",
        url: `${server.origin}/only/start`,
      });

      expect(received.map((cookie) => cookie?.split("; ").toSorted())).toStrictEqual([
        ["host=one"],
        ["host=one", "path=two"],
        undefined,
      ]);
    });

    it("keeps a seed whose public-suffix Domain is the target host on that host only", async () => {
      const received: string[] = [];

      await using server = await startFixtureServer((request, response, origins) => {
        received.push(`${request.url ?? ""} ${request.headers.cookie ?? "-"}`);

        if (request.url === "/start") {
          const subdomain = origins.crossOrigin.replace("//localhost", "//sub.localhost");

          response.writeHead(302, { Location: `${subdomain}/sub` });
          response.end();

          return;
        }

        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<p>done</p>");
      });

      await using client = new XrioClient({ mode: "http" });
      await client.scrape({
        cookies: ["suffix=one; Domain=localhost; Path=/"],
        format: "html",
        url: `${server.crossOrigin}/start`,
      });

      expect(received).toStrictEqual(["/start suffix=one", "/sub -"]);
    });

    it("skips seeds a browser would refuse, sends the rest, and publishes each skip", async () => {
      const received: (string | undefined)[] = [];
      const skips: { detail: string; scrapeId: string }[] = [];

      const recordSkip: ChannelListener = (message) => {
        if (isCookieSkip(message)) {
          skips.push({ detail: message.detail, scrapeId: message.scrapeId });
        }
      };

      await using server = await startFixtureServer((request, response) => {
        received.push(request.headers.cookie);
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end("<p>done</p>");
      });

      await using client = new XrioClient({ mode: "http" });

      subscribe("xrio:event", recordSkip);

      try {
        await client.scrape({
          cookies: [
            "good=one; Path=/",
            "lax=two; SameSite=None; Path=/",
            "__Secure-plain=three; Path=/",
            "foreign=four; Domain=example.com; Path=/",
          ],
          format: "html",
          url: `${server.origin}/page`,
        });
      } finally {
        unsubscribe("xrio:event", recordSkip);
      }

      const scrapeId = skips[0]?.scrapeId;

      expect(received).toStrictEqual(["good=one"]);
      expect(skips).toStrictEqual([
        { detail: '{"name":"lax","reason":"same-site-none-insecure"}', scrapeId },
        { detail: '{"name":"__Secure-plain","reason":"prefix-rules"}', scrapeId },
        { detail: '{"name":"foreign","reason":"domain-mismatch"}', scrapeId },
      ]);
    });
  });
});
