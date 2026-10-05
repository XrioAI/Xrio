import { once } from "node:events";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
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

const echo = createServer({ allowHalfOpen: true }, (socket) => {
  socket.on("data", (chunk: Buffer) => {
    socket.write(chunk);
  });
  socket.once("end", () => {
    socket.end("bye");
  });
});

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

describe(startRelay, () => {
  let echoPort: number;

  beforeAll(async () => {
    echoPort = await listenOnLoopback(echo);
  });

  afterAll(() => {
    echo.close();
  });

  it("tunnels directly, forwarding bytes sent with the CONNECT and half-closing each direction", async () => {
    await using relay = await startRelay(undefined, startDeadline(10_000));
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
    await using relay = await startRelay(proxy, startDeadline(10_000));
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

      await using relay = await startRelay(proxyEndpoint(fake.url), startDeadline(10_000));
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
    await using relay = await startRelay(proxy, startDeadline(10_000));
    const socket = await sendConnect(relay.url, "origin.test:443", "hello");
    const received = readAll(socket);

    await vi.waitFor(() => {
      expect(socket.bytesRead).toBeGreaterThan(40);
    });
    socket.end();

    await expect(received).resolves.toMatch(/hellobye$/u);
    expect(fake.requests).toStrictEqual([{ authority: "origin.test", authorization: undefined }]);
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

      await using relay = await startRelay(proxyEndpoint(fake.url), startDeadline(10_000));

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
    await using relay = await startRelay(proxy, startDeadline(10_000));
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
    await using relay = await startRelay(proxyEndpoint(fake.url), startDeadline(10_000));
    const reply = await readAll(await sendConnect(relay.url, authority));

    expect(statusOf(reply)).toBe(403);
    expect(fake.requests).toHaveLength(0);
  });

  it("refuses local clients that do not present the relay's token", async () => {
    await using relay = await startRelay(undefined, startDeadline(10_000));
    const reply = await readAll(await sendConnect(relay.url, `127.0.0.1:${echoPort}`, "", false));

    expect(statusOf(reply)).toBe(407);
  });

  it("refuses a token of the right length that does not match", async () => {
    await using relay = await startRelay(undefined, startDeadline(10_000));
    const forged = new URL(relay.url);

    forged.password = "0".repeat(forged.password.length);

    const reply = await readAll(await sendConnect(forged.href, `127.0.0.1:${echoPort}`));

    expect(statusOf(reply)).toBe(407);
  });
});
