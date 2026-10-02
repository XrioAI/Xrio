import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { resolveProfile } from "wreq-js";

import { XrioClient } from "../client.ts";
import {
  closedLoopbackPort,
  listenOnLoopback,
  startFixtureServer,
} from "../testing/fixture-server.ts";
import type { FixtureServer } from "../testing/fixture-server.ts";

const USER_AGENT_MAJOR = /Chrome\/(?<major>\d+)\.0\.0\.0/u;

const html = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

const startRawOrigin = async (answer: (socket: Socket, requestHead: string) => void) => {
  const server = createTcpServer((socket) => {
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("data", (chunk: Buffer) => {
      answer(socket, chunk.toString("latin1"));
    });
  });

  const port = await listenOnLoopback(server);

  return { origin: `http://127.0.0.1:${port}`, server };
};

const routes = (request: IncomingMessage, response: ServerResponse) => {
  response
    .writeHead(200, { "content-type": "text/html" })
    .end(
      html(
        `<p id="cookie">${request.headers.cookie ?? ""}</p><p id="ua">${request.headers["user-agent"] ?? ""}</p>`,
      ),
    );
};

describe("http mode", () => {
  let fixture: FixtureServer;
  let origin: string;
  const client = new XrioClient();

  beforeAll(async () => {
    fixture = await startFixtureServer(routes);
    ({ origin } = fixture);
  });

  afterAll(async () => {
    await fixture[Symbol.asyncDispose]();
  });

  it("presents Linux Chrome with the newest Chrome profile the client offers", async () => {
    const result = await client.scrape({ format: "json", url: `${origin}/` });
    const major = USER_AGENT_MAJOR.exec(result.data.content.text)?.groups?.major;

    expect(result.data.content.text).toContain("(X11; Linux x86_64)");
    expect(`chrome_${major}`).toBe(resolveProfile("chrome"));
  });

  it("ignores ambient proxy variables", async () => {
    const deadProxy = `http://127.0.0.1:${await closedLoopbackPort()}`;

    const ambientVariables = {
      ALL_PROXY: deadProxy,
      HTTPS_PROXY: deadProxy,
      HTTP_PROXY: deadProxy,
      NO_PROXY: "",
      http_proxy: deadProxy,
      https_proxy: deadProxy,
    };

    const saved = new Map(Object.keys(ambientVariables).map((name) => [name, process.env[name]]));

    Object.assign(process.env, ambientVariables);

    try {
      await expect(client.scrape({ format: "html", url: `${origin}/` })).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          // oxlint-disable-next-line typescript/no-dynamic-delete -- process.env stores any assignment, including undefined, as a string.
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

describe("http mode edge responses", () => {
  const client = new XrioClient();

  it("returns a response whose reason phrase holds a control character", async () => {
    const { origin, server } = await startRawOrigin((socket) => {
      socket.end("HTTP/1.1 200 O\u0001K\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nhi");
    });

    try {
      await expect(client.scrape({ format: "html", url: `${origin}/` })).resolves.toMatchObject({
        data: "hi",
        status: 200,
      });
    } finally {
      server.close();
    }
  });
});
