import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { inspect } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { resolveProfile } from "wreq-js";

import { XrioClient } from "../client.ts";
import { startFakeHttpProxy, startFakeSocksProxy } from "../testing/fake-proxies.ts";
import {
  closedLoopbackPort,
  listenOnLoopback,
  startFixtureServer,
} from "../testing/fixture-server.ts";
import type { FixtureServer } from "../testing/fixture-server.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

const HOP = /^\/hop\/(?<remaining>\d+)$/u;

const USER_AGENT_MAJOR = /Chrome\/(?<major>\d+)\.0\.0\.0/u;

const CHROME_HTTP1_HEADER_ORDER = [
  "Host",
  "Connection",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "Upgrade-Insecure-Requests",
  "User-Agent",
  "Accept",
  "Sec-Fetch-Site",
  "Sec-Fetch-Mode",
  "Sec-Fetch-User",
  "Sec-Fetch-Dest",
  "Accept-Encoding",
  "Accept-Language",
  "Priority",
];

const html = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

const headerNames = (requestHead: string) =>
  requestHead
    .split("\r\n")
    .slice(1)
    .filter((line) => line !== "")
    .map((line) => line.split(":", 1)[0]);

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

const writeLargeBody = (response: ServerResponse) => {
  const chunk = Buffer.alloc(1024 * 1024, "a");
  response.writeHead(200, { "content-type": "text/html" });

  for (let written = 0; written < MAX_BODY_BYTES; written += chunk.byteLength) {
    response.write(chunk);
  }

  response.end("b");
};

const routes = (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://fixture.test");
  const charsetPage = charsetPages.get(url.pathname);
  const remaining = HOP.exec(url.pathname)?.groups?.remaining;

  if (charsetPage !== undefined) {
    response.writeHead(200, { "content-type": charsetPage.contentType }).end(charsetPage.bytes);
  } else if (remaining !== undefined && remaining !== "0") {
    response
      .writeHead(302, {
        location: `/hop/${Number(remaining) - 1}`,
        "set-cookie": `hop${remaining}=1; Path=/`,
      })
      .end();
  } else if (url.pathname === "/reset-mid-body") {
    response.writeHead(200, { "content-length": "1000", "content-type": "text/html" });
    response.write("<p>partial", () => {
      response.socket?.destroy();
    });
  } else if (url.pathname === "/empty-location") {
    response
      .writeHead(302, { "content-type": "text/html", location: "" })
      .end(html("<p>moved</p>"));
  } else if (url.pathname === "/large") {
    writeLargeBody(response);
  } else if (url.pathname === "/challenge") {
    response
      .writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/html" })
      .end(html("<p>Just a moment...</p>"));
  } else if (url.pathname === "/challenge.json") {
    response
      .writeHead(403, { "cf-mitigated": "challenge", "content-type": "application/json" })
      .end('{"error":"challenge"}');
  } else {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(
        html(
          `<p id="cookie">${request.headers.cookie ?? ""}</p><p id="ua">${request.headers["user-agent"] ?? ""}</p>`,
        ),
      );
  }
};

describe("http mode", () => {
  let fixture: FixtureServer;
  let origin: string;
  let fixturePort: number;
  const client = new XrioClient({ mode: "http" });

  beforeAll(async () => {
    fixture = await startFixtureServer(routes);
    ({ origin } = fixture);
    fixturePort = Number(new URL(origin).port);
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

  it("rejects a decoded body over 32 MiB", async () => {
    await expect(client.scrape({ format: "html", url: `${origin}/large` })).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });

  it("sends cookies set on one redirect hop with the next and returns the final URL", async () => {
    const result = await client.scrape({ format: "json", url: `${origin}/hop/2` });

    expect(result.url).toBe(`${origin}/hop/0`);
    expect(result.data.content.text).toContain("hop2=1; hop1=1");
  });

  it("follows 20 redirects and refuses the 21st", async () => {
    await expect(client.scrape({ format: "html", url: `${origin}/hop/20` })).resolves.toMatchObject(
      {
        status: 200,
        url: `${origin}/hop/0`,
      },
    );
    await expect(client.scrape({ format: "html", url: `${origin}/hop/21` })).rejects.toMatchObject({
      code: "TOO_MANY_REDIRECTS",
    });
  });

  it("reports a block on results and on unsupported-content errors", async () => {
    const page = await client.scrape({ format: "html", url: `${origin}/challenge` });
    const delivered = await client.scrape({ format: "html", url: `${origin}/hop/1` });

    expect(page.block).toMatchObject({ vendor: "cloudflare", verdict: "blocked" });
    expect(delivered.block).toStrictEqual({
      challenge: null,
      evidence: [],
      passedChallenges: [],
      vendor: null,
      verdict: "ok",
    });
    await expect(
      client.scrape({ format: "html", url: `${origin}/challenge.json` }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
      details: { block: { vendor: "cloudflare", verdict: "blocked" } },
    });
  });

  it("presents Linux Chrome with the newest Chrome profile the client offers", async () => {
    const result = await client.scrape({ format: "json", url: `${origin}/` });
    const major = USER_AGENT_MAJOR.exec(result.data.content.text)?.groups?.major;

    expect(result.data.content.text).toContain("(X11; Linux x86_64)");
    expect(`chrome_${major}`).toBe(resolveProfile("chrome"));
  });

  it("maps a rejected certificate to TLS_CERTIFICATE_INVALID", async () => {
    const server = createHttpsServer({
      cert: readFileSync(new URL("../testing/test-only-cert.pem", import.meta.url)),
      key: readFileSync(new URL("../testing/test-only-key.pem", import.meta.url)),
    });

    const port = await listenOnLoopback(server);

    try {
      await expect(
        client.scrape({ format: "html", url: `https://127.0.0.1:${port}/` }),
      ).rejects.toMatchObject({
        code: "TLS_CERTIFICATE_INVALID",
      });
    } finally {
      server.close();
    }
  });

  it("maps a DNS failure to NETWORK_ERROR", async () => {
    await expect(
      client.scrape({ format: "html", url: "http://nonexistent.invalid/" }),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("ignores ambient proxy variables", async () => {
    await using ambient = await startFakeHttpProxy({ tunnelTo: fixturePort });

    const ambientVariables = {
      ALL_PROXY: ambient.url,
      HTTPS_PROXY: ambient.url,
      HTTP_PROXY: ambient.url,
      NO_PROXY: "",
      http_proxy: ambient.url,
      https_proxy: ambient.url,
    };

    const saved = new Map(Object.keys(ambientVariables).map((name) => [name, process.env[name]]));

    Object.assign(process.env, ambientVariables);

    try {
      await expect(client.scrape({ format: "html", url: `${origin}/` })).resolves.toMatchObject({
        status: 200,
      });
      expect(ambient.requests).toHaveLength(0);
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

  it("scrapes through an authenticated HTTP proxy", async () => {
    await using proxy = await startFakeHttpProxy({
      requireCredentials: "user:p@ss",
      tunnelTo: fixturePort,
    });

    const proxied = new XrioClient({
      mode: "http",
      proxy: proxy.url.replace("://", "://user:p%40ss@"),
    });

    await expect(
      proxied.scrape({ format: "html", url: "http://origin.test/" }),
    ).resolves.toMatchObject({
      status: 200,
      url: "http://origin.test/",
    });
    expect(proxy.requests).toStrictEqual([
      { authority: "http://origin.test/", authorization: `Basic ${btoa("user:p@ss")}` },
    ]);
  });

  it("scrapes through an authenticated SOCKS5 proxy that resolves the target name", async () => {
    await using proxy = await startFakeSocksProxy({
      requireCredentials: "user:secret",
      tunnelTo: fixturePort,
    });

    await expect(
      client.scrape({
        format: "html",
        proxy: proxy.url.replace("://", "://user:secret@"),
        url: "http://origin.test/",
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(proxy.requests).toStrictEqual([{ authority: "origin.test", authorization: undefined }]);
  });

  it.each([
    { code: "PROXY_AUTH_FAILED", connectStatus: 407 },
    { code: "NETWORK_ERROR", connectStatus: 502 },
    { code: "PROXY_CONNECT_FAILED", connectStatus: 403 },
  ])(
    "reports a CONNECT $connectStatus from the proxy as $code",
    async ({ code, connectStatus }) => {
      await using proxy = await startFakeHttpProxy({ connectStatus, tunnelTo: fixturePort });

      await expect(
        client.scrape({ format: "html", proxy: proxy.url, url: "https://origin.test/" }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("reports a proxy that refuses connections as PROXY_UNREACHABLE", async () => {
    const port = await closedLoopbackPort();

    const rejection = client.scrape({
      format: "html",
      proxy: `http://user:secret@127.0.0.1:${port}`,
      url: "https://origin.test/",
    });

    await expect(rejection).rejects.toMatchObject({ code: "PROXY_UNREACHABLE" });
    await expect(rejection).rejects.toSatisfy(
      (error) => !inspect(error, { depth: Infinity }).includes("secret"),
    );
  });
});

describe("http mode edge responses", () => {
  const client = new XrioClient({ mode: "http" });

  it("reports a connection reset mid-body as NETWORK_ERROR straight away", async () => {
    await using fixture = await startFixtureServer(routes);
    const started = performance.now();

    await expect(
      client.scrape({ format: "html", timeoutMs: 10_000, url: `${fixture.origin}/reset-mid-body` }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("returns a redirect status whose Location is empty instead of following it", async () => {
    await using fixture = await startFixtureServer(routes);

    await expect(
      client.scrape({ format: "html", url: `${fixture.origin}/empty-location` }),
    ).resolves.toMatchObject({ status: 302, url: `${fixture.origin}/empty-location` });
  });

  it("refuses a redirect to a URL that carries credentials without contacting it", async () => {
    let connections = 0;

    const destination = await startRawOrigin((socket) => {
      socket.resetAndDestroy();
    });

    destination.server.on("connection", () => {
      connections += 1;
    });
    const credentialed = destination.origin.replace("://", "://user:secret@");

    const redirector = await startRawOrigin((socket) => {
      socket.end(
        `HTTP/1.1 302 Found\r\nLocation: ${credentialed}/after\r\nContent-Length: 0\r\n\r\n`,
      );
    });

    try {
      const rejection = client.scrape({ format: "html", url: `${redirector.origin}/` });

      await expect(rejection).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      await expect(rejection).rejects.toSatisfy(
        (error) => !inspect(error, { depth: Infinity }).includes("secret"),
      );
    } finally {
      destination.server.close();
      redirector.server.close();
    }

    expect(connections).toBe(0);
  });

  it("reports a status below 100 as NETWORK_ERROR", async () => {
    const { origin, server } = await startRawOrigin((socket) => {
      socket.end("HTTP/1.1 099 Odd\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nhi");
    });

    try {
      await expect(client.scrape({ format: "html", url: `${origin}/` })).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
    } finally {
      server.close();
    }
  });

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

  it("classifies a transport failure by the error, not by the request URL", async () => {
    const { origin, server } = await startRawOrigin((socket) => {
      socket.destroy();
    });

    try {
      await expect(
        client.scrape({ format: "html", url: `${origin}/CERTIFICATE_VERIFY_FAILED` }),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    } finally {
      server.close();
    }
  });

  it("sends HTTP/1.1 headers in Chrome's order and case, keeping the connection alive", async () => {
    const requestHeads: string[] = [];

    const { origin, server } = await startRawOrigin((socket, requestHead) => {
      requestHeads.push(requestHead);
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nhi");
    });

    try {
      await client.scrape({ format: "html", url: `${origin}/` });
    } finally {
      server.close();
    }

    expect(requestHeads.map(headerNames)).toStrictEqual([CHROME_HTTP1_HEADER_ORDER]);
    expect(requestHeads[0]).toContain("\r\nConnection: keep-alive\r\n");
    expect(requestHeads[0]).toContain("\r\nAccept-Language: en-US,en;q=0.9\r\n");
  });

  it.each([
    {
      clientLocale: "de-DE",
      header: "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
      locale: undefined,
      reported: "de-DE",
    },
    {
      clientLocale: "ja-JP",
      header: "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      locale: "fr-FR",
      reported: "fr-FR",
    },
    {
      clientLocale: undefined,
      header: "en-AU,en-US;q=0.9,en;q=0.8",
      locale: "en-AU",
      reported: "en-AU",
    },
  ])(
    "sends the pinned locale's Accept-Language in Chrome's position and reports $reported",
    async ({ clientLocale, header, locale, reported }) => {
      const requestHeads: string[] = [];

      const { origin, server } = await startRawOrigin((socket, requestHead) => {
        requestHeads.push(requestHead);
        socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nhi");
      });

      try {
        const result = await new XrioClient({ locale: clientLocale, mode: "http" }).scrape({
          format: "html",
          locale,
          url: `${origin}/`,
        });

        expect(result.identity).toMatchObject({ locale: reported, mode: "http" });
      } finally {
        server.close();
      }

      expect(requestHeads.map(headerNames)).toStrictEqual([CHROME_HTTP1_HEADER_ORDER]);
      expect(requestHeads[0]).toContain(`\r\nAccept-Language: ${header}\r\n`);
    },
  );
});
