import { spawn } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { XrioClient } from "../client.ts";
import { startDeadline } from "../deadline.ts";
import type { Clock } from "../deadline.ts";
import { httpIdentity } from "../humanizer/humanizer.ts";
import { parseProxy } from "../options.ts";
import { startFakeHttpProxy, TEST_ONLY_CERT } from "../testing/fake-proxies.ts";
import { listenOnLoopback } from "../testing/fixture-server.ts";
import { manualClock } from "../testing/manual-clock.ts";
import { createHttpConnections } from "./http-connections.ts";
import type { HttpConnections } from "./http-connections.ts";
import { loadHttpDocument } from "./http.ts";

const TEST_ONLY_KEY = readFileSync(new URL("../testing/test-only-key.pem", import.meta.url));

const UNCLOSED_CHILD = fileURLToPath(new URL("../testing/unclosed-http-child.ts", import.meta.url));

const EXIT_BUDGET_MS = 5000;

const page = "<!doctype html><html><head><title>Kept</title></head><body><p>Kept</p></body></html>";

interface OriginReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

const HTML_REPLY: OriginReply = { headers: { "content-type": "text/html" }, status: 200 };

const BLOCKED_REPLY: OriginReply = {
  headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
  status: 403,
};

const startTlsOrigin = async (replies: readonly OriginReply[] = []) => {
  const cookies: (string | undefined)[] = [];
  const clientPorts: (number | undefined)[] = [];
  const sockets = new Set<Socket>();
  let handshakes = 0;

  const server = createHttpsServer(
    { cert: TEST_ONLY_CERT, key: TEST_ONLY_KEY },
    (request, response) => {
      const { headers, status } = replies[cookies.length] ?? HTML_REPLY;

      cookies.push(request.headers.cookie);
      clientPorts.push(request.socket.remotePort);
      response.writeHead(status, { ...headers, "set-cookie": "visited=yes; Path=/" }).end(page);
    },
  );

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  server.on("secureConnection", () => {
    handshakes += 1;
  });

  const port = await listenOnLoopback(server);

  return {
    [Symbol.dispose]: () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      server.close();
    },
    get connectionOrder() {
      const opened = [...new Set(clientPorts)];

      return clientPorts.map((clientPort) => opened.indexOf(clientPort));
    },
    cookies,
    get handshakes() {
      return handshakes;
    },
    get openSockets() {
      return sockets.size;
    },
    port,
    url: `https://127.0.0.1:${port}/`,
  };
};

const withCredentials = (url: string, credentials: string) =>
  url.replace("://", `://${credentials}@`);

const configDirectories: string[] = [];

const configuredClient = (proxyUrl: string, retries = 0) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-reuse-"));
  const configFile = path.join(directory, "xrio.config.json");

  configDirectories.push(directory);
  writeFileSync(configFile, JSON.stringify({ proxy: { url: proxyUrl }, scrape: { retries } }));

  return new XrioClient({ configFile, mode: "http" });
};

type HttpRoute = Parameters<HttpConnections["lend"]>[0];

const directRoute: HttpRoute = { pinnedExit: true, proxy: undefined };

const stickyRoute = (proxyUrl: string, credentials: string): HttpRoute => ({
  pinnedExit: true,
  proxy: parseProxy(withCredentials(proxyUrl, credentials)),
});

const loadThrough = async (
  connections: HttpConnections,
  url: string,
  route: HttpRoute = directRoute,
  headers: Readonly<Record<string, string>> = {},
  clock?: Clock,
) => {
  using deadline = startDeadline(10_000, undefined, clock);

  return await loadHttpDocument(
    {
      capabilities: null,
      cookies: [],
      headers,
      identity: httpIdentity({ locale: "en-US" }),
      kind: "http",
      ...route,
      url: new URL(url),
    },
    deadline,
    connections,
  );
};

const trustTestCertificate = () => {
  vi.stubEnv(
    "SSL_CERT_FILE",
    fileURLToPath(new URL("../testing/test-only-cert.pem", import.meta.url)),
  );
};

describe("http connection reuse", () => {
  beforeAll(trustTestCertificate);

  afterAll(() => {
    vi.unstubAllEnvs();

    for (const directory of configDirectories) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("sends sequential scrapes of an origin over one TLS connection", async () => {
    using origin = await startTlsOrigin();
    await using client = new XrioClient({ mode: "http" });

    await client.scrape({ format: "html", url: origin.url });
    await client.scrape({ format: "html", url: origin.url });
    await client.scrape({ format: "html", url: origin.url });

    expect({ handshakes: origin.handshakes, requests: origin.cookies.length }).toStrictEqual({
      handshakes: 1,
      requests: 3,
    });
  });

  it("sends a later scrape none of the cookies an earlier scrape seeded or received", async () => {
    using origin = await startTlsOrigin();
    await using client = new XrioClient({ mode: "http" });

    await client.scrape({ cookies: ["seeded=one; Path=/"], format: "html", url: origin.url });
    await client.scrape({ format: "html", url: origin.url });

    expect({ cookies: origin.cookies, handshakes: origin.handshakes }).toStrictEqual({
      cookies: ["seeded=one", undefined],
      handshakes: 1,
    });
  });

  it("opens one proxy tunnel for sequential scrapes through the configured sticky session", async () => {
    using origin = await startTlsOrigin();
    await using proxy = await startFakeHttpProxy({ tunnelTo: origin.port });
    await using client = configuredClient(withCredentials(proxy.url, "user-{session}:secret"));

    await client.scrape({ format: "html", url: "https://origin.test/" });
    await client.scrape({ format: "html", url: "https://origin.test/" });

    expect({
      handshakes: origin.handshakes,
      tunnels: proxy.requests.map(({ authority }) => authority),
    }).toStrictEqual({ handshakes: 1, tunnels: ["origin.test:443"] });
  });

  it("moves the retry of a blocked scrape to a new tunnel and keeps that one for the next scrape", async () => {
    using origin = await startTlsOrigin([BLOCKED_REPLY]);
    await using proxy = await startFakeHttpProxy({ tunnelTo: origin.port });
    await using client = configuredClient(withCredentials(proxy.url, "user-{session}:secret"), 1);

    const retried = await client.scrape({ format: "html", url: "https://origin.test/" });
    const next = await client.scrape({ format: "html", url: "https://origin.test/" });
    const sessions = proxy.requests.map(({ authorization }) => authorization);

    expect({
      attempts: [retried.attempts, next.attempts],
      connectionOrder: origin.connectionOrder,
      handshakes: origin.handshakes,
      sessions: new Set(sessions).size,
      tunnels: sessions.length,
      verdicts: [retried.block.verdict, next.block.verdict],
    }).toStrictEqual({
      attempts: [
        { freshExits: 1, total: 2 },
        { freshExits: 0, total: 1 },
      ],
      connectionOrder: [0, 1, 1],
      handshakes: 2,
      sessions: 2,
      tunnels: 2,
      verdicts: ["ok", "ok"],
    });
  });

  it.each([
    { route: "an explicit client proxy", scrapeProxy: false, source: "client" },
    { route: "an explicit scrape proxy", scrapeProxy: true, source: "client" },
    { route: "a configured proxy without a session", scrapeProxy: false, source: "config" },
  ] as const)(
    "opens a fresh tunnel for every scrape through $route",
    async ({ scrapeProxy, source }) => {
      using origin = await startTlsOrigin();
      await using proxy = await startFakeHttpProxy({ tunnelTo: origin.port });
      const proxyUrl = withCredentials(proxy.url, "user:secret");

      await using client =
        source === "config"
          ? configuredClient(proxyUrl)
          : new XrioClient({ mode: "http", proxy: scrapeProxy ? undefined : proxyUrl });

      const scrape = {
        format: "html",
        proxy: scrapeProxy ? proxyUrl : undefined,
        url: "https://origin.test/",
      } as const;

      await client.scrape(scrape);
      await client.scrape(scrape);

      await vi.waitFor(() => {
        expect({
          handshakes: origin.handshakes,
          kept: proxy.openConnections,
          tunnels: proxy.requests.map(({ authority }) => authority),
        }).toStrictEqual({
          handshakes: 2,
          kept: 0,
          tunnels: ["origin.test:443", "origin.test:443"],
        });
      });
    },
  );

  it("opens a fresh tunnel for an explicit proxy that names the configured sticky session", async () => {
    using origin = await startTlsOrigin();
    await using proxy = await startFakeHttpProxy({ tunnelTo: origin.port });
    await using client = configuredClient(withCredentials(proxy.url, "user-{session}:secret"));

    await client.scrape({ format: "html", url: "https://origin.test/" });
    const session = atob(proxy.requests[0]?.authorization?.slice("Basic ".length) ?? "");

    await client.scrape({
      format: "html",
      proxy: withCredentials(proxy.url, session),
      url: "https://origin.test/",
    });

    expect({
      handshakes: origin.handshakes,
      tunnels: proxy.requests.map(
        ({ authorization }) => authorization === proxy.requests[0]?.authorization,
      ),
    }).toStrictEqual({ handshakes: 2, tunnels: [true, true] });
  });

  it("never shares a connection between routes, sticky sessions or header orders", async () => {
    using origin = await startTlsOrigin();
    await using proxy = await startFakeHttpProxy({ tunnelTo: origin.port });
    const connections = createHttpConnections();
    const sessionOne = stickyRoute(proxy.url, "user-session-1:secret");
    const sessionTwo = stickyRoute(proxy.url, "user-session-2:secret");
    const target = "https://origin.test/";

    try {
      await loadThrough(connections, origin.url);
      await loadThrough(connections, target, sessionOne);
      await loadThrough(connections, target, sessionOne);
      await loadThrough(connections, target, sessionTwo);
      await loadThrough(connections, target, sessionOne, { "x-trace": "1" });
      await loadThrough(connections, origin.url);
    } finally {
      await connections.close();
    }

    expect({
      handshakes: origin.handshakes,
      tunnels: proxy.requests.map(({ authorization }) => atob(authorization?.slice(6) ?? "")),
    }).toStrictEqual({
      handshakes: 4,
      tunnels: ["user-session-1:secret", "user-session-2:secret", "user-session-1:secret"],
    });
  });

  it("closes every kept connection when the client closes", async () => {
    using origin = await startTlsOrigin();
    await using proxy = await startFakeHttpProxy({ tunnelTo: origin.port });
    const client = configuredClient(withCredentials(proxy.url, "user-{session}:secret"));

    await client.scrape({ format: "html", url: "https://origin.test/" });
    const kept = [proxy.openConnections, origin.openSockets];

    await client.close();

    await vi.waitFor(() => {
      expect({ afterClose: [proxy.openConnections, origin.openSockets], kept }).toStrictEqual({
        afterClose: [0, 0],
        kept: [1, 1],
      });
    });
  });

  it("closes a kept connection after 30 s without a scrape", async () => {
    const { advance, clock } = manualClock();
    const connections = createHttpConnections(clock.setTimer);
    using origin = await startTlsOrigin();

    try {
      await loadThrough(connections, origin.url);
      advance(29_999);
      const beforeIdleTimeout = origin.openSockets;

      advance(1);

      await vi.waitFor(() => {
        expect([beforeIdleTimeout, origin.openSockets]).toStrictEqual([1, 0]);
      });
    } finally {
      await connections.close();
    }
  });

  it("keeps at most six idle connections to a route after a burst of scrapes", async () => {
    const connections = createHttpConnections();
    using origin = await startTlsOrigin();

    try {
      await Promise.all(
        Array.from({ length: 8 }, async () => await loadThrough(connections, origin.url)),
      );

      await vi.waitFor(() => {
        expect([origin.handshakes, origin.openSockets]).toStrictEqual([8, 6]);
      });
    } finally {
      await connections.close();
    }
  });

  it("lets a process that never closes its client exit while a kept connection sits idle", async () => {
    using origin = await startTlsOrigin();

    const child = spawn(process.execPath, [UNCLOSED_CHILD, origin.url], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const exited = once(child, "exit").then(() => true);

    try {
      const report = await Promise.race([
        once(createInterface({ input: child.stdout }), "line").then(([line]) => String(line)),
        exited.then(() => "exited before reporting"),
      ]);

      const exitedInTime = await Promise.race([
        exited,
        delay(EXIT_BUDGET_MS, false, { ref: false }),
      ]);

      expect({ exitedInTime, handshakes: origin.handshakes, report }).toStrictEqual({
        exitedInTime: true,
        handshakes: 1,
        report: '{"status":200}',
      });
    } finally {
      child.kill();
    }
  }, 20_000);

  it("does not blame a later scrape for the proxy failure an earlier scrape met", async () => {
    let refusals = 1;

    const flakyProxy = createServer((_request, response) => {
      if (refusals > 0) {
        refusals -= 1;
        response.writeHead(407).end();

        return;
      }

      response.writeHead(200, { "content-type": "text/html" }).end(page);
    });

    const port = await listenOnLoopback(flakyProxy);

    try {
      await using client = configuredClient(`http://user-{session}:secret@127.0.0.1:${port}`);

      await expect(
        client.scrape({ format: "html", url: "http://origin.test/" }),
      ).rejects.toMatchObject({ code: "PROXY_AUTH_FAILED" });
      await expect(
        client.scrape({ format: "html", url: "http://origin.test/" }),
      ).resolves.toMatchObject({ status: 200 });
    } finally {
      flakyProxy.close();
    }
  });

  it("keeps proxy credentials out of diagnostics and errors", async () => {
    const published: unknown[] = [];

    const record: ChannelListener = (message) => {
      published.push(message);
    };

    using origin = await startTlsOrigin();

    await using proxy = await startFakeHttpProxy({
      requireCredentials: "user:s3cret-pass",
      tunnelTo: origin.port,
    });

    subscribe("xrio:stage", record);
    subscribe("xrio:event", record);

    try {
      await using client = new XrioClient({ mode: "http" });

      await client.scrape({
        format: "html",
        proxy: withCredentials(proxy.url, "user:s3cret-pass"),
        url: "https://origin.test/",
      });

      const failing = client.scrape({
        format: "html",
        proxy: withCredentials(proxy.url, "user:wrong-s3cret-pass"),
        url: "https://origin.test/",
      });

      await expect(failing).rejects.toMatchObject({ code: "PROXY_AUTH_FAILED" });
      await expect(failing).rejects.toSatisfy(
        (error) => !inspect(error, { depth: Infinity }).includes("s3cret"),
      );
      expect({
        leaked: inspect(published, { depth: Infinity }).includes("s3cret"),
        published: published.length,
      }).toStrictEqual({ leaked: false, published: 6 });
    } finally {
      unsubscribe("xrio:stage", record);
      unsubscribe("xrio:event", record);
    }
  });
});

describe("a kept lane", () => {
  beforeAll(trustTestCertificate);

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("does not keep the connection of a scrape that failed", async () => {
    using origin = await startTlsOrigin([
      { headers: { "content-type": "application/json" }, status: 200 },
    ]);

    await using client = new XrioClient({ mode: "http" });

    await expect(client.scrape({ format: "html", url: origin.url })).rejects.toMatchObject({
      code: "UNSUPPORTED_CONTENT_TYPE",
    });
    await client.scrape({ format: "html", url: origin.url });
    await client.scrape({ format: "html", url: origin.url });

    expect({ handshakes: origin.handshakes, requests: origin.cookies.length }).toStrictEqual({
      handshakes: 2,
      requests: 3,
    });
  });

  it("opens new tunnels within the deadline of the scrape it is lent to", async () => {
    const { advance, clock } = manualClock();
    const connections = createHttpConnections(clock.setTimer);
    using first = await startTlsOrigin();
    using second = await startTlsOrigin();

    try {
      await loadThrough(connections, first.url, directRoute, {}, clock);
      advance(20_000);
      const later = await loadThrough(connections, second.url, directRoute, {}, clock);

      expect({
        handshakes: [first.handshakes, second.handshakes],
        status: later.status,
      }).toStrictEqual({
        handshakes: [1, 1],
        status: 200,
      });
    } finally {
      await connections.close();
    }
  });

  it("sends a request that skips the kept transport through the lane's route all the same", async () => {
    using origin = await startTlsOrigin();
    await using proxy = await startFakeHttpProxy({ tunnelTo: origin.port });
    const connections = createHttpConnections();

    try {
      using deadline = startDeadline(10_000);

      await using lane = await connections.lend(
        stickyRoute(proxy.url, "user:secret"),
        { browser: "chrome", defaultHeaders: {}, emulation: {}, os: "linux" },
        deadline,
      );

      await using session = await lane.startSession({});
      const response = await session.fetch("https://origin.test/");

      expect({
        body: await response.text(),
        tunnels: proxy.requests.map(({ authority }) => authority),
      }).toStrictEqual({ body: page, tunnels: ["origin.test:443"] });
    } finally {
      await connections.close();
    }
  });
});
