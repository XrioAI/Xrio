import { once } from "node:events";
import { Agent, createServer as createHttpServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { inspect } from "node:util";

import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { resolveClientOptions } from "../options.ts";
import {
  startFakeHttpProxy,
  startFakeSocksProxy,
  TEST_ONLY_CERT,
} from "../testing/fake-proxies.ts";
import { closedLoopbackPort, listenOnLoopback } from "../testing/fixture-server.ts";
import { manualClock } from "../testing/manual-clock.ts";
import { startRelay } from "./relay.ts";

const proxyEndpoint = (url: string) => {
  const { route: proxy } = resolveClientOptions({ mode: "http", proxy: url });

  if (proxy === undefined) {
    throw new Error("Expected a proxy endpoint.");
  }

  return proxy;
};

const withCredentials = (url: string, credentials: string) =>
  url.replace("://", `://${credentials}@`);

const echoBack = (socket: Socket) => {
  socket.on("data", (chunk: Buffer) => {
    socket.write(chunk);
  });
  socket.once("end", () => {
    socket.end("bye");
  });
};

const createEcho = () => createServer({ allowHalfOpen: true }, echoBack);

const readAll = async (socket: Socket): Promise<string> => {
  const chunks: Buffer[] = [];

  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(socket, "end");

  return Buffer.concat(chunks).toString("latin1");
};

const sendConnect = async (
  relayUrl: string,
  authority: string,
  early = "",
  admitted = true,
): Promise<Socket> => {
  const socket = connect({
    allowHalfOpen: true,
    host: "127.0.0.1",
    port: Number(new URL(relayUrl).port),
  });

  const { password, username } = new URL(relayUrl);
  const authorization = `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString("base64")}\r\n`;

  await once(socket, "connect");
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${admitted ? authorization : ""}\r\n${early}`,
  );

  return socket;
};

const statusOf = (reply: string) => Number(reply.slice("HTTP/1.1 ".length, "HTTP/1.1 ".length + 3));

const exchange = async (relayUrl: string, authority: string): Promise<string> => {
  const socket = await sendConnect(relayUrl, authority, "hello");
  const received = readAll(socket);

  await vi.waitFor(() => {
    expect(socket.bytesRead).toBeGreaterThan(0);
  });
  socket.end();

  return await received;
};

const authoritiesSeenBy = (fake: { requests: { authority: string }[] }) =>
  fake.requests.map(({ authority }) => authority);

const ESTABLISHED_HELLO = "HTTP/1.1 200 Connection Established\r\n\r\nhellobye";

describe(startRelay, () => {
  const echo = createEcho();
  let echoPort: number;

  beforeAll(async () => {
    echoPort = await listenOnLoopback(echo);
  });

  afterAll(() => {
    echo.close();
  });

  it("tunnels directly, forwarding bytes sent with the CONNECT and half-closing each direction", async () => {
    await using relay = await startRelay(undefined, startDeadline(10_000), "token");
    const socket = await sendConnect(relay.url, `127.0.0.1:${echoPort}`, "client-hello");
    const received = readAll(socket);

    await vi.waitFor(() => {
      expect(socket.bytesRead).toBeGreaterThan(0);
    });
    socket.end();

    await expect(received).resolves.toBe(
      "HTTP/1.1 200 Connection Established\r\n\r\nclient-hellobye",
    );
  });

  it("tunnels through an HTTP proxy with Basic credentials", async () => {
    await using fake = await startFakeHttpProxy({
      requireCredentials: "us:er:p@ss",
      tunnelTo: echoPort,
    });

    const proxy = proxyEndpoint(withCredentials(fake.url, "us:er:p%40ss"));
    await using relay = await startRelay(proxy, startDeadline(10_000), "token");
    const socket = await sendConnect(relay.url, "origin.test:443", "hello");
    const received = readAll(socket);

    await vi.waitFor(() => {
      expect(socket.bytesRead).toBeGreaterThan(40);
    });
    socket.end();

    await expect(received).resolves.toMatch(/^HTTP\/1\.1 200 .*hellobye$/su);
    expect(fake.requests).toStrictEqual([
      { authority: "origin.test:443", authorization: `Basic ${btoa("us:er:p@ss")}` },
    ]);
  });

  it("keeps the client's half open after the target half-closes through an HTTPS proxy", async () => {
    const trusted = getCACertificates("default");
    const afterTargetEnd = Promise.withResolvers<string>();

    const closesFirst = createServer({ allowHalfOpen: true }, (socket) => {
      socket.end("target-done");
      void readAll(socket).then(afterTargetEnd.resolve);
    });

    setDefaultCACertificates([...trusted, TEST_ONLY_CERT.toString()]);

    try {
      await using fake = await startFakeHttpProxy({
        secure: true,
        tunnelTo: await listenOnLoopback(closesFirst),
      });

      await using relay = await startRelay(proxyEndpoint(fake.url), startDeadline(10_000), "token");
      const socket = await sendConnect(relay.url, "origin.test:443");

      await expect(readAll(socket)).resolves.toMatch(/^HTTP\/1\.1 200 .*target-done$/su);
      socket.end("client-late");

      await expect(afterTargetEnd.promise).resolves.toBe("client-late");
    } finally {
      setDefaultCACertificates(trusted);
      closesFirst.close();
    }
  });

  it("tunnels through SOCKS5 with credentials and leaves DNS to the proxy", async () => {
    await using fake = await startFakeSocksProxy({
      requireCredentials: "user:secret",
      tunnelTo: echoPort,
    });

    const proxy = proxyEndpoint(withCredentials(fake.url, "user:secret"));
    await using relay = await startRelay(proxy, startDeadline(10_000), "token");
    const socket = await sendConnect(relay.url, "origin.test:443", "hello");
    const received = readAll(socket);

    await vi.waitFor(() => {
      expect(socket.bytesRead).toBeGreaterThan(40);
    });
    socket.end();

    await expect(received).resolves.toMatch(/hellobye$/u);
    expect(fake.requests).toStrictEqual([
      { authority: "origin.test", authorization: "user:secret" },
    ]);
  });

  it.each([
    { code: "PROXY_AUTH_FAILED", connectStatus: 407, proxyWide: true },
    { code: "NETWORK_ERROR", connectStatus: 502, proxyWide: false },
    { code: "NETWORK_ERROR", connectStatus: 504, proxyWide: false },
    { code: "PROXY_CONNECT_FAILED", connectStatus: 403, proxyWide: false },
  ])(
    "answers 502 and records $code when the proxy replies $connectStatus",
    async ({ code, connectStatus, proxyWide }) => {
      await using fake = await startFakeHttpProxy({ connectStatus, tunnelTo: echoPort });

      await using relay = await startRelay(proxyEndpoint(fake.url), startDeadline(10_000), "token");

      const reply = await readAll(await sendConnect(relay.url, "origin.test:443"));

      expect(statusOf(reply)).toBe(502);
      expect(relay.failureFor("origin.test")).toMatchObject({ code, name: "XrioError" });
      expect(relay.failureFor("other.test") !== undefined).toBe(proxyWide);
    },
  );

  it("records SOCKS5 credential rejection for every host", async () => {
    await using fake = await startFakeSocksProxy({
      requireCredentials: "user:right",
      tunnelTo: echoPort,
    });

    const proxy = proxyEndpoint(withCredentials(fake.url, "user:wrong"));
    await using relay = await startRelay(proxy, startDeadline(10_000), "token");
    const reply = await readAll(await sendConnect(relay.url, "origin.test:443"));

    expect(statusOf(reply)).toBe(502);
    expect(relay.failureFor("other.test")).toMatchObject({ code: "PROXY_AUTH_FAILED" });
    expect(inspect(relay.failureFor("other.test"), { depth: Infinity })).not.toContain("wrong");
  });

  it("records an unreachable proxy for every host without leaking its credentials", async () => {
    const port = await closedLoopbackPort();

    await using relay = await startRelay(
      proxyEndpoint(`http://user:secret@127.0.0.1:${port}`),
      startDeadline(10_000),
      "token",
    );

    const reply = await readAll(await sendConnect(relay.url, "origin.test:443"));

    expect(statusOf(reply)).toBe(502);
    expect(relay.failureFor("other.test")).toMatchObject({ code: "PROXY_UNREACHABLE" });
    expect(inspect(relay.failureFor("other.test"), { depth: Infinity })).not.toContain("secret");
  });

  it("gives up on a proxy that never answers CONNECT once its reply stage times out", async () => {
    const { advance, clock } = manualClock();

    await using fake = await startFakeHttpProxy({ silent: true, tunnelTo: echoPort });

    await using relay = await startRelay(
      proxyEndpoint(fake.url),
      startDeadline(60_000, undefined, clock),
      "token",
    );

    const reply = readAll(await sendConnect(relay.url, "origin.test:443"));

    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(1);
    });
    advance(10_000);

    expect(statusOf(await reply)).toBe(502);
    expect(relay.failureFor("origin.test")).toMatchObject({ code: "NETWORK_ERROR" });
  });

  it.each([
    "127.0.0.1:443",
    "localhost:443",
    "app.localhost:80",
    "[::1]:443",
    "[::ffff:127.0.0.1]:443",
    "169.254.169.254:80",
  ])("refuses to send the local target %s through a proxy", async (authority) => {
    await using fake = await startFakeHttpProxy({ tunnelTo: echoPort });
    await using relay = await startRelay(proxyEndpoint(fake.url), startDeadline(10_000), "token");
    const reply = await readAll(await sendConnect(relay.url, authority));

    expect(statusOf(reply)).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });

  it("admits a client without a token under loopback admission and tunnels through the proxy", async () => {
    await using fake = await startFakeHttpProxy({ tunnelTo: echoPort });

    await using relay = await startRelay(
      proxyEndpoint(fake.url),
      startDeadline(10_000),
      "loopback",
    );

    const { hostname, password, username } = new URL(relay.url);
    const socket = await sendConnect(relay.url, "origin.test:443", "hello", false);
    const received = readAll(socket);

    await vi.waitFor(() => {
      expect(socket.bytesRead).toBeGreaterThan(40);
    });
    socket.end();

    await expect(received).resolves.toBe("HTTP/1.1 200 Connection Established\r\n\r\nhellobye");
    expect({ hostname, password, username }).toStrictEqual({
      hostname: "127.0.0.1",
      password: "",
      username: "",
    });
    expect(fake.requests).toStrictEqual([
      { authority: "origin.test:443", authorization: undefined },
    ]);
  });

  it("answers 407 to the same client without a token under token admission", async () => {
    await using fake = await startFakeHttpProxy({ tunnelTo: echoPort });
    await using relay = await startRelay(proxyEndpoint(fake.url), startDeadline(10_000), "token");
    const reply = await readAll(await sendConnect(relay.url, "origin.test:443", "hello", false));

    expect(reply).toBe("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    expect(new URL(relay.url).username).toBe("xrio");
    expect(fake.requests).toStrictEqual([]);
  });

  it("refuses local clients that do not present the relay's token", async () => {
    await using relay = await startRelay(undefined, startDeadline(10_000), "token");
    const reply = await readAll(await sendConnect(relay.url, `127.0.0.1:${echoPort}`, "", false));

    expect(statusOf(reply)).toBe(407);
  });

  it("refuses a token of the right length that does not match", async () => {
    await using relay = await startRelay(undefined, startDeadline(10_000), "token");
    const forged = new URL(relay.url);

    forged.password = "0".repeat(forged.password.length);

    const reply = await readAll(await sendConnect(forged.href, `127.0.0.1:${echoPort}`));

    expect(statusOf(reply)).toBe(407);
  });
});

describe("a relay told its first URL", () => {
  const echo = createEcho();
  let echoPort: number;

  beforeAll(async () => {
    echoPort = await listenOnLoopback(echo);
  });

  afterAll(() => {
    echo.close();
  });

  it("hands the tunnel it held for its first URL to the first CONNECT there", async () => {
    await using fake = await startFakeHttpProxy({
      requireCredentials: "user:secret",
      tunnelTo: echoPort,
    });

    const proxy = proxyEndpoint(withCredentials(fake.url, "user:secret"));
    using deadline = startDeadline(10_000);
    const firstUrl = new URL("https://origin.test/page");
    await using relay = await startRelay(proxy, deadline, "loopback", firstUrl);

    await vi.waitFor(() => {
      expect(fake.answeredConnects).toBe(1);
    });

    await expect(exchange(relay.url, "origin.test:443")).resolves.toBe(ESTABLISHED_HELLO);
    expect(fake.requests).toStrictEqual([
      { authority: "origin.test:443", authorization: `Basic ${btoa("user:secret")}` },
    ]);
  });

  it("keeps its held tunnel past CONNECTs to other authorities, and hands it over only once", async () => {
    await using fake = await startFakeHttpProxy({ tunnelTo: echoPort });
    using deadline = startDeadline(10_000);
    const firstUrl = new URL("https://origin.test:8443/");
    await using relay = await startRelay(proxyEndpoint(fake.url), deadline, "loopback", firstUrl);

    await vi.waitFor(() => {
      expect(fake.answeredConnects).toBe(1);
    });

    await expect(exchange(relay.url, "other.test:443")).resolves.toBe(ESTABLISHED_HELLO);
    await expect(exchange(relay.url, "origin.test:8443")).resolves.toBe(ESTABLISHED_HELLO);

    const afterHandover = authoritiesSeenBy(fake);

    await expect(exchange(relay.url, "origin.test:8443")).resolves.toBe(ESTABLISHED_HELLO);
    expect([afterHandover, authoritiesSeenBy(fake)]).toStrictEqual([
      ["origin.test:8443", "other.test:443"],
      ["origin.test:8443", "other.test:443", "origin.test:8443"],
    ]);
  });

  it("dials afresh at once when its held tunnel is still opening, and drops it when it lands", async () => {
    const proxyAnswers = Promise.withResolvers<null>();

    await using fake = await startFakeHttpProxy({
      holdFirstConnectUntil: proxyAnswers.promise,
      tunnelTo: echoPort,
    });

    using deadline = startDeadline(10_000);
    const firstUrl = new URL("https://origin.test/");
    await using relay = await startRelay(proxyEndpoint(fake.url), deadline, "loopback", firstUrl);

    await vi.waitFor(() => {
      expect(authoritiesSeenBy(fake)).toStrictEqual(["origin.test:443"]);
    });

    const received = await exchange(relay.url, "origin.test:443");
    const whileHeldWaits = [fake.answeredConnects, authoritiesSeenBy(fake)];

    proxyAnswers.resolve(null);

    await vi.waitFor(() => {
      expect([fake.answeredConnects, fake.openConnections]).toStrictEqual([2, 0]);
    });
    expect([received, whileHeldWaits, relay.failureFor("origin.test")]).toStrictEqual([
      ESTABLISHED_HELLO,
      [1, ["origin.test:443", "origin.test:443"]],
      undefined,
    ]);
  });

  it("replays the client's bytes on a fresh tunnel when the held one closes before answering", async () => {
    let accepted = 0;

    const closesFirst = createServer({ allowHalfOpen: true }, (socket) => {
      accepted += 1;

      if (accepted === 1) {
        socket.once("data", () => {
          socket.destroy();
        });
      } else {
        echoBack(socket);
      }
    });

    try {
      const tunnelTo = await listenOnLoopback(closesFirst);
      await using fake = await startFakeHttpProxy({ tunnelTo });
      using deadline = startDeadline(10_000);
      const firstUrl = new URL("https://origin.test/");
      await using relay = await startRelay(proxyEndpoint(fake.url), deadline, "loopback", firstUrl);

      await vi.waitFor(() => {
        expect(fake.answeredConnects).toBe(1);
      });

      await expect(exchange(relay.url, "origin.test:443")).resolves.toBe(ESTABLISHED_HELLO);
      await vi.waitFor(() => {
        expect(fake.openConnections).toBe(0);
      });
      expect([accepted, authoritiesSeenBy(fake), relay.failureFor("origin.test")]).toStrictEqual([
        2,
        ["origin.test:443", "origin.test:443"],
        undefined,
      ]);
    } finally {
      closesFirst.close();
    }
  });

  it("dials afresh after its held tunnel was refused, recording nothing for the refusal", async () => {
    await using fake = await startFakeHttpProxy({ refuseFirstConnects: 1, tunnelTo: echoPort });
    using deadline = startDeadline(10_000);
    const firstUrl = new URL("https://origin.test/");
    await using relay = await startRelay(proxyEndpoint(fake.url), deadline, "loopback", firstUrl);

    await vi.waitFor(() => {
      expect([fake.requests.length, fake.openConnections]).toStrictEqual([1, 0]);
    });

    await expect(exchange(relay.url, "origin.test:443")).resolves.toBe(ESTABLISHED_HELLO);
    expect([relay.failureFor("origin.test"), authoritiesSeenBy(fake)]).toStrictEqual([
      undefined,
      ["origin.test:443", "origin.test:443"],
    ]);
  });

  it("records the client's CONNECT failure but not its held tunnel's", async () => {
    await using fake = await startFakeHttpProxy({
      requireCredentials: "user:right",
      tunnelTo: echoPort,
    });

    const proxy = proxyEndpoint(withCredentials(fake.url, "user:wrong"));
    using deadline = startDeadline(10_000);
    const firstUrl = new URL("https://origin.test/");
    await using relay = await startRelay(proxy, deadline, "loopback", firstUrl);

    await vi.waitFor(() => {
      expect([fake.requests.length, fake.openConnections]).toStrictEqual([1, 0]);
    });

    const failureBeforeClient = relay.failureFor("other.test");
    const reply = await readAll(await sendConnect(relay.url, "origin.test:443"));

    expect([failureBeforeClient, statusOf(reply)]).toStrictEqual([undefined, 502]);
    expect(relay.failureFor("other.test")).toMatchObject({ code: "PROXY_AUTH_FAILED" });
  });

  it("closes the tunnel it held once the deadline aborts, before the relay closes", async () => {
    await using fake = await startFakeHttpProxy({ tunnelTo: echoPort });
    const controller = new AbortController();
    using deadline = startDeadline(10_000, controller.signal);
    const firstUrl = new URL("https://origin.test/");
    await using _relay = await startRelay(proxyEndpoint(fake.url), deadline, "loopback", firstUrl);

    await vi.waitFor(() => {
      expect(fake.openConnections).toBe(1);
    });
    controller.abort();

    await vi.waitFor(() => {
      expect(fake.openConnections).toBe(0);
    });
  });

  it("closes the tunnel it held when it closes", async () => {
    await using fake = await startFakeHttpProxy({ tunnelTo: echoPort });
    using deadline = startDeadline(10_000);
    const firstUrl = new URL("https://origin.test/");

    {
      await using _relay = await startRelay(
        proxyEndpoint(fake.url),
        deadline,
        "loopback",
        firstUrl,
      );

      await vi.waitFor(() => {
        expect(fake.openConnections).toBe(1);
      });
    }

    await vi.waitFor(() => {
      expect(fake.openConnections).toBe(0);
    });
  });

  it("closes the tunnel it held when the client that took it has already hung up", async () => {
    const proxyAnswers = Promise.withResolvers<null>();

    await using fake = await startFakeHttpProxy({
      connectDelayMs: 300,
      holdFirstConnectUntil: proxyAnswers.promise,
      tunnelTo: echoPort,
    });

    using deadline = startDeadline(10_000);
    const firstUrl = new URL("https://origin.test/");
    await using relay = await startRelay(proxyEndpoint(fake.url), deadline, "loopback", firstUrl);

    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(1);
    });

    const client = await sendConnect(relay.url, "origin.test:443");

    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(2);
    });
    client.destroy();
    await delay(50);
    proxyAnswers.resolve(null);

    await vi.waitFor(() => {
      expect([fake.answeredConnects, fake.openConnections]).toStrictEqual([2, 0]);
    });
  });

  it("stops waiting for the proxy handshake of the tunnel it held once it closes", async () => {
    const { clock, pendingTimers } = manualClock();
    const accepted = Promise.withResolvers<null>();

    const silent = createServer((socket) => {
      socket.resume();
      accepted.resolve(null);
    });

    try {
      const port = await listenOnLoopback(silent);
      using deadline = startDeadline(60_000, undefined, clock);
      const proxy = proxyEndpoint(`https://127.0.0.1:${port}`);
      const firstUrl = new URL("https://origin.test/");
      const relay = await startRelay(proxy, deadline, "loopback", firstUrl);

      await accepted.promise;
      const whileDialing = pendingTimers();

      await relay[Symbol.asyncDispose]();

      await vi.waitFor(() => {
        expect([whileDialing, pendingTimers()]).toStrictEqual([2, 1]);
      });
    } finally {
      silent.close();
    }
  });

  it.each([
    "http://origin.test/",
    "https://127.0.0.1/",
    "https://localhost:8443/",
    "https://[::1]/",
  ])("holds no tunnel for the first URL %s", async (firstUrl) => {
    await using fake = await startFakeHttpProxy({ tunnelTo: echoPort });
    using deadline = startDeadline(10_000);
    const proxy = proxyEndpoint(fake.url);
    await using relay = await startRelay(proxy, deadline, "loopback", new URL(firstUrl));

    await expect(exchange(relay.url, "origin.test:443")).resolves.toBe(ESTABLISHED_HELLO);
    expect(authoritiesSeenBy(fake)).toStrictEqual(["origin.test:443"]);
  });
});

const listeningServers = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;

describe("a relay lent to a later scrape", () => {
  it("stops holding the process open while it rests and holds it again once lent", async () => {
    using firstScrape = startDeadline(10_000);
    using laterScrape = startDeadline(10_000);
    await using relay = await startRelay(undefined, firstScrape, "token");
    const whileLent = listeningServers();

    relay.rest();
    const whileResting = listeningServers();

    relay.lendTo(laterScrape);

    expect([whileLent - whileResting, listeningServers() - whileResting]).toStrictEqual([1, 1]);
  });

  it("reports to the scrape it is lent to only the failures of the tunnels it opens", async () => {
    const { advance, clock } = manualClock();

    await using fake = await startFakeHttpProxy({ silent: true, tunnelTo: 0 });

    await using relay = await startRelay(
      proxyEndpoint(fake.url),
      startDeadline(60_000, undefined, clock),
      "token",
    );

    const earlierReply = readAll(await sendConnect(relay.url, "origin.test:443"));

    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(1);
    });
    relay.lendTo(startDeadline(60_000, undefined, clock));
    advance(10_000);
    await earlierReply;
    const afterEarlierTunnel = relay.failureFor("origin.test")?.code;

    const laterReply = readAll(await sendConnect(relay.url, "origin.test:443"));

    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(2);
    });
    advance(10_000);
    await laterReply;

    expect([afterEarlierTunnel, relay.failureFor("origin.test")?.code]).toStrictEqual([
      undefined,
      "NETWORK_ERROR",
    ]);
  });
});

const PAST_NODE_KEEP_ALIVE_MS = 6500;

const getThroughRelay = async (relayUrl: string, target: string, agent: Agent) => {
  const { password, port, username } = new URL(relayUrl);
  const answered = Promise.withResolvers<IncomingMessage>();

  const request = httpRequest(
    {
      agent,
      headers: { "proxy-authorization": `Basic ${btoa(`${username}:${password}`)}` },
      host: "127.0.0.1",
      path: target,
      port: Number(port),
    },
    answered.resolve,
  );

  request.once("error", answered.reject);
  request.end();
  const response = await answered.promise;

  response.resume();
  await once(response, "end");

  return { reusedSocket: request.reusedSocket, status: response.statusCode };
};

describe("a relay's idle client connection", () => {
  it("stays open for as long as its client keeps it", async () => {
    const origin = createHttpServer((_request, response) => {
      response.end("ok");
    });

    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const target = `http://127.0.0.1:${await listenOnLoopback(origin)}/`;

    try {
      await using relay = await startRelay(undefined, startDeadline(30_000), "token");
      const first = await getThroughRelay(relay.url, target, agent);

      await delay(PAST_NODE_KEEP_ALIVE_MS);

      expect([first, await getThroughRelay(relay.url, target, agent)]).toStrictEqual([
        { reusedSocket: false, status: 200 },
        { reusedSocket: true, status: 200 },
      ]);
    } finally {
      agent.destroy();
      origin.close();
    }
  }, 15_000);
});
