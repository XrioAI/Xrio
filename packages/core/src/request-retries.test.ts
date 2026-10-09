import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { XrioClient } from "./client.ts";
import { startFixtureServer } from "./testing/fixture-server.ts";

const directories: string[] = [];

const clientRetrying = (retries: number): XrioClient => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-retries-"));
  const configFile = path.join(directory, "xrio.config.json");

  directories.push(directory);
  writeFileSync(configFile, JSON.stringify({ scrape: { retries } }));

  return new XrioClient({ configFile, mode: "http" });
};

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
});
