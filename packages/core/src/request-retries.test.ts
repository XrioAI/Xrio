import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { XrioClient } from "./client.ts";
import type { XrioConfig } from "./client.ts";
import { startFakeHttpProxy } from "./testing/fake-proxies.ts";
import type { FakeProxy } from "./testing/fake-proxies.ts";
import { startFixtureServer } from "./testing/fixture-server.ts";

const directories: string[] = [];

const clientWith = (config: XrioConfig): XrioClient => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-retries-"));
  const configFile = path.join(directory, "xrio.config.json");

  directories.push(directory);
  writeFileSync(configFile, JSON.stringify(config));

  return new XrioClient({ configFile, mode: "http" });
};

const clientRetrying = (retries: number): XrioClient => clientWith({ scrape: { retries } });

const proxyUsersOf = (proxy: FakeProxy): (string | undefined)[] =>
  proxy.requests.map(({ authorization }) => {
    const credentials = Buffer.from(authorization?.replace("Basic ", "") ?? "", "base64");
    const [user] = credentials.toString().split(":", 1);

    return user;
  });

const SESSION_USER = /^user-\d{8}$/u;

describe("HTTP transport retries", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("retries a failed connection with the caller's headers and seed cookies", async () => {
    const requests: { authorization: string | undefined; cookie: string | undefined }[] = [];

    await using server = await startFixtureServer((request, response) => {
      requests.push({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
      });

      if (requests.length === 1) {
        request.socket.destroy();

        return;
      }

      response.writeHead(200, { "content-type": "text/html" }).end("<p>Recovered</p>");
    });

    await using client = clientRetrying(1);

    const result = await client.scrape({
      cookies: ["session=seed; Path=/; HttpOnly"],
      format: "html",
      headers: { authorization: "Bearer fixture" },
      mode: "http",
      timeoutMs: 10_000,
      url: server.origin,
    });

    expect(result.data).toBe("<p>Recovered</p>");
    expect(requests).toStrictEqual([
      { authorization: "Bearer fixture", cookie: "session=seed" },
      { authorization: "Bearer fixture", cookie: "session=seed" },
    ]);
  });

  it("does not retry a failed connection by default", async () => {
    let requests = 0;

    await using server = await startFixtureServer((request) => {
      requests += 1;
      request.socket.destroy();
    });

    await using client = new XrioClient({ mode: "http" });

    await expect(client.scrape({ format: "html", url: server.origin })).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
    expect(requests).toBe(1);
  });

  it("stops after the requested number of additional attempts", async () => {
    let requests = 0;

    await using server = await startFixtureServer((request) => {
      requests += 1;
      request.socket.destroy();
    });

    await using client = clientRetrying(2);

    await expect(
      client.scrape({ format: "html", timeoutMs: 10_000, url: server.origin }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(requests).toBe(3);
  });

  it("returns an HTTP refusal without retrying it", async () => {
    let requests = 0;

    await using server = await startFixtureServer((_request, response) => {
      requests += 1;
      response.writeHead(403, { "content-type": "text/html" }).end("<p>Refused</p>");
    });

    await using client = clientRetrying(2);

    const result = await client.scrape({ format: "html", url: server.origin });

    expect({ data: result.data, requests, status: result.status }).toStrictEqual({
      data: "<p>Refused</p>",
      requests: 1,
      status: 403,
    });
  });

  it("retries a blocked response once on a fresh proxy session", async () => {
    let requests = 0;

    await using origin = await startFixtureServer((_request, response) => {
      requests += 1;

      if (requests === 1) {
        response
          .writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/html" })
          .end("<p>Blocked</p>");

        return;
      }

      response.writeHead(200, { "content-type": "text/html" }).end("<p>Recovered</p>");
    });

    await using proxy = await startFakeHttpProxy({ tunnelTo: Number(new URL(origin.origin).port) });

    await using client = clientWith({
      proxy: { url: proxy.url.replace("://", "://user-{session}:secret@") },
      scrape: { retries: 1 },
    });

    const result = await client.scrape({
      format: "html",
      timeoutMs: 10_000,
      url: "http://origin.test/",
    });

    const [blocked, fresh] = proxyUsersOf(proxy);

    expect({
      data: result.data,
      originRequests: requests,
      proxyRequests: proxy.requests.length,
      verdict: result.block.verdict,
    }).toStrictEqual({
      data: "<p>Recovered</p>",
      originRequests: 2,
      proxyRequests: 2,
      verdict: "ok",
    });
    expect([blocked, fresh]).toStrictEqual([
      expect.stringMatching(SESSION_USER),
      expect.stringMatching(SESSION_USER),
    ]);
    expect(fresh).not.toBe(blocked);
  });

  it("returns a blocked response through a proxy without {session} without retrying it", async () => {
    await using origin = await startFixtureServer((_request, response) => {
      response
        .writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/html" })
        .end("<p>Blocked</p>");
    });

    await using proxy = await startFakeHttpProxy({ tunnelTo: Number(new URL(origin.origin).port) });

    await using client = clientWith({
      proxy: { url: proxy.url.replace("://", "://user:secret@") },
      scrape: { retries: 2 },
    });

    const result = await client.scrape({ format: "html", url: "http://origin.test/" });

    expect({
      users: proxyUsersOf(proxy),
      verdict: result.block.verdict,
    }).toStrictEqual({
      users: ["user"],
      verdict: "blocked",
    });
  });
});
