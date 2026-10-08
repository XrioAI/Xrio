import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "./client.ts";
import { startFixtureServer } from "./testing/fixture-server.ts";

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
  describe("HTTP request controls", () => {
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
