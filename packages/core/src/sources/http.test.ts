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

const charsetPages = new Map(
  Object.entries({
    "/charset/header-shift-jis": {
      bytes: Buffer.concat([
        Buffer.from("<p>"),
        Buffer.from([0x93, 0xfa, 0x96, 0x7b]),
        Buffer.from("</p>"),
      ]),
      contentType: "text/html; charset=Shift_JIS",
    },
    "/charset/latin1": {
      bytes: Buffer.from([0x3c, 0x70, 0x3e, 0x80, 0x3c, 0x2f, 0x70, 0x3e]),
      contentType: 'text/html; charset="iso-8859-1"',
    },
    "/charset/meta-windows-1251": {
      bytes: Buffer.concat([
        Buffer.from(
          '<html><head><!-- <meta charset="koi8-r"> --><meta charset="windows-1251"></head><body><p>',
        ),
        Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
        Buffer.from("</p></body></html>"),
      ]),
      contentType: "text/html",
    },
    "/charset/utf-16-bom": {
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<p>Hi</p>", "utf16le")]),
      contentType: "text/html; charset=windows-1252",
    },
  }),
);

const routes = (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://fixture.test");
  const charsetPage = charsetPages.get(url.pathname);

  if (charsetPage === undefined) {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        html(
          `<p id="cookie">${request.headers.cookie ?? ""}</p><p id="ua">${request.headers["user-agent"] ?? ""}</p>`,
        ),
      );
  } else {
    response.writeHead(200, { "content-type": charsetPage.contentType }).end(charsetPage.bytes);
  }
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

  it.each([
    { expected: "<p>Привет</p>", path: "/charset/meta-windows-1251" },
    { expected: "<p>日本</p>", path: "/charset/header-shift-jis" },
    { expected: "<p>Hi</p>", path: "/charset/utf-16-bom" },
    { expected: "<p>€</p>", path: "/charset/latin1" },
  ])("decodes $path with WHATWG rules", async ({ expected, path }) => {
    const result = await client.scrape({ format: "html", url: `${origin}${path}` });

    expect(result.data).toContain(expected);
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
