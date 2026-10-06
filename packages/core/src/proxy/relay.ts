import { randomBytes, timingSafeEqual } from "node:crypto";
import { on, once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, Server, ServerResponse } from "node:http";
import { BlockList, connect as connectTcp, isIP, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { connect as connectTls } from "node:tls";

import { SocksClient } from "socks";

import type { Deadline } from "../deadline.ts";
import { XrioError } from "../errors.ts";
import type { ProxyEndpoint } from "../types.ts";

declare module "node:tls" {
  interface ConnectionOptions {
    readonly allowHalfOpen?: boolean;
  }
}

const DIAL_TIMEOUT_MS = 10_000;

const CONNECT_REPLY_TIMEOUT_MS = 10_000;

const MAX_REPLY_HEAD_BYTES = 16_384;

const IPV6_BRACKETS = /^\[|\]$/gu;

const TRAILING_DOT = /\.$/u;

const AUTHORITY_WITH_PORT = /:\d+$/u;

const STATUS_LINE = /^HTTP\/1\.[01] (?<status>\d{3})/u;

const SOCKS_AUTH_FAILURE = /Authentication failed|no accepted authentication/u;

const SOCKS_REJECTION = /rejected connection/u;

const HOP_BY_HOP_PROXY_HEADERS = new Set(["proxy-authorization", "proxy-connection"]);

const RELAY_USER = "xrio";

const RELAY_TOKEN_BYTES = 16;

const localAddresses = new BlockList();

localAddresses.addSubnet("127.0.0.0", 8, "ipv4");

localAddresses.addSubnet("169.254.0.0", 16, "ipv4");

localAddresses.addAddress("0.0.0.0", "ipv4");

localAddresses.addAddress("::", "ipv6");

localAddresses.addAddress("::1", "ipv6");

localAddresses.addSubnet("fe80::", 10, "ipv6");

interface Target {
  hostname: string;
  port: number;
}

interface ForwardingConnection {
  socket: Duplex;
  absoluteForm: boolean;
}

export interface Relay extends AsyncDisposable {
  readonly url: string;
  readonly failureFor: (hostname: string) => XrioError | undefined;
}

const unbracketed = (hostname: string): string => hostname.replaceAll(IPV6_BRACKETS, "");

const isLocalTarget = (hostname: string): boolean => {
  const host = unbracketed(hostname).toLowerCase().replace(TRAILING_DOT, "");
  const family = isIP(host);

  if (family === 0) {
    return host === "localhost" || host.endsWith(".localhost");
  }

  return localAddresses.check(host, family === 6 ? "ipv6" : "ipv4");
};

const parseAuthority = (authority: string | undefined): Target | undefined => {
  const url = URL.parse(`http://${authority ?? ""}`);

  if (
    url === null ||
    !AUTHORITY_WITH_PORT.test(authority ?? "") ||
    url.pathname !== "/" ||
    url.username !== ""
  ) {
    return undefined;
  }

  return { hostname: url.hostname, port: url.port === "" ? 80 : Number(url.port) };
};

const networkError = (message: string, cause?: unknown) =>
  new XrioError("NETWORK_ERROR", message, { cause, details: undefined });

const PROXY_WIDE_FAILURES = new Set(["PROXY_AUTH_FAILED", "PROXY_UNREACHABLE"]);

const proxyAuthFailed = (proxy: ProxyEndpoint, cause?: unknown) =>
  new XrioError("PROXY_AUTH_FAILED", `The proxy ${proxy.redactedUrl} rejected its credentials.`, {
    cause,
    details: undefined,
  });

const proxyUnreachable = (proxy: ProxyEndpoint, message: string, cause: unknown) =>
  new XrioError("PROXY_UNREACHABLE", `${message} ${proxy.redactedUrl}.`, {
    cause,
    details: undefined,
  });

const readReplyStatus = async (socket: Duplex, signal: AbortSignal): Promise<number> => {
  let received = Buffer.alloc(0);

  for await (const [chunk] of on(socket, "data", { close: ["close", "end"], signal })) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("The proxy socket emitted text instead of bytes.");
    }

    received = Buffer.concat([received, chunk]);
    const headEnd = received.indexOf("\r\n\r\n");

    if (headEnd !== -1) {
      socket.pause();
      socket.unshift(received.subarray(headEnd + 4));

      const status = STATUS_LINE.exec(received.subarray(0, headEnd).toString("latin1"))?.groups
        ?.status;

      if (status === undefined) {
        throw new Error("The proxy sent a malformed CONNECT reply.");
      }

      return Number(status);
    }

    if (received.byteLength > MAX_REPLY_HEAD_BYTES) {
      throw new Error("The proxy sent an oversized CONNECT reply.");
    }
  }

  throw new Error("The proxy closed the connection before replying to CONNECT.");
};

const forwardedHeaders = (
  rawHeaders: string[],
  proxyAuthorization: string | undefined,
): string[] => {
  const headers: string[] = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];

    if (!HOP_BY_HOP_PROXY_HEADERS.has(name.toLowerCase())) {
      headers.push(name, rawHeaders[index + 1]);
    }
  }

  if (proxyAuthorization !== undefined) {
    headers.push("Proxy-Authorization", proxyAuthorization);
  }

  return headers;
};

const basicAuthorization = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

const relayBody = async (
  upstreamResponse: IncomingMessage,
  response: ServerResponse,
  outbound: ClientRequest,
): Promise<void> => {
  try {
    await pipeline(upstreamResponse, response);
  } catch {
    outbound.destroy();
  }
};

const splice = (client: Duplex, upstream: Duplex, clientHead: Buffer) => {
  if (client.destroyed) {
    upstream.destroy();

    return;
  }

  if (clientHead.byteLength > 0) {
    upstream.write(clientHead);
  }

  client.once("close", () => {
    upstream.destroy();
  });
  upstream.once("close", () => {
    client.destroy();
  });
  client.pipe(upstream);
  upstream.pipe(client);
};

const replyTimedOut = (proxy: ProxyEndpoint, authority: string, cause: unknown): XrioError =>
  networkError(
    `The proxy ${proxy.redactedUrl} did not open a tunnel to ${authority} in time.`,
    cause,
  );

const tunnelRefusal = (
  proxy: ProxyEndpoint,
  authority: string,
  status: number,
): XrioError | undefined => {
  if (status === 407) {
    return proxyAuthFailed(proxy);
  }

  if (status >= 502 && status <= 504) {
    return networkError(`The proxy ${proxy.redactedUrl} could not reach ${authority} (${status}).`);
  }

  if (status < 200 || status > 299) {
    return new XrioError(
      "PROXY_CONNECT_FAILED",
      `The proxy ${proxy.redactedUrl} refused a tunnel to ${authority} (${status}).`,
      { details: { status } },
    );
  }

  return undefined;
};

const socksFailure = (proxy: ProxyEndpoint, target: Target, socksError: Error): XrioError => {
  const { message } = socksError;
  const cause = new Error(message);

  if (SOCKS_AUTH_FAILURE.test(message)) {
    return proxyAuthFailed(proxy, cause);
  }

  if (SOCKS_REJECTION.test(message)) {
    return networkError(
      `The SOCKS proxy ${proxy.redactedUrl} could not reach ${target.hostname}:${target.port}.`,
      cause,
    );
  }

  return proxyUnreachable(proxy, "The SOCKS handshake failed with", cause);
};

class ProxyRelay {
  readonly #upstream: ProxyEndpoint | undefined;
  readonly #deadline: Deadline;
  readonly #proxyAuthorization: string | undefined;
  readonly #clientAuthorization: Buffer;
  readonly #sockets = new Set<Duplex>();
  readonly #hostFailures = new Map<string, XrioError>();
  #proxyFailure: XrioError | undefined;

  constructor(upstream: ProxyEndpoint | undefined, deadline: Deadline, token: string) {
    this.#upstream = upstream;
    this.#deadline = deadline;
    this.#clientAuthorization = Buffer.from(basicAuthorization(RELAY_USER, token));

    const credentials = upstream?.credentials;

    this.#proxyAuthorization =
      credentials === undefined
        ? undefined
        : basicAuthorization(credentials.username, credentials.password);
  }

  admits(request: IncomingMessage): boolean {
    const presented = Buffer.from(request.headers["proxy-authorization"] ?? "");

    return (
      presented.byteLength === this.#clientAuthorization.byteLength &&
      timingSafeEqual(presented, this.#clientAuthorization)
    );
  }

  failureFor(hostname: string): XrioError | undefined {
    return this.#proxyFailure ?? this.#hostFailures.get(hostname);
  }

  track<Stream extends Duplex>(socket: Stream): Stream {
    this.#sockets.add(socket);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      this.#sockets.delete(socket);
    });

    if (socket instanceof Socket) {
      socket.setNoDelay(true);
    }

    return socket;
  }

  destroySockets() {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
  }

  async relayConnect(client: Duplex, authority: string | undefined, clientHead: Buffer) {
    const target = parseAuthority(authority);

    if (target === undefined) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");

      return;
    }

    if (this.#refusesLocalTarget(target)) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");

      return;
    }

    let tunnel: Duplex;

    try {
      tunnel = await this.#openTunnel(target);
    } catch (error) {
      this.#recordFailure(target, error instanceof XrioError ? error : undefined);
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");

      return;
    }

    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    splice(client, tunnel, clientHead);
  }

  async relayRequest(request: IncomingMessage, response: ServerResponse) {
    try {
      await this.#forwardRequest(request, response);
    } catch {
      response.destroy();
    }
  }

  async #forwardRequest(request: IncomingMessage, response: ServerResponse) {
    const url = URL.parse(request.url ?? "");

    if (url === null || url.protocol !== "http:") {
      response.writeHead(400).end();

      return;
    }

    const target = { hostname: url.hostname, port: url.port === "" ? 80 : Number(url.port) };

    if (this.#refusesLocalTarget(target)) {
      response.writeHead(403).end();

      return;
    }

    let connection: ForwardingConnection;

    try {
      connection = await this.#openForwardingConnection(target);
    } catch (error) {
      this.#recordFailure(target, error instanceof XrioError ? error : undefined);
      response.writeHead(502).end();

      return;
    }

    if (response.destroyed) {
      connection.socket.destroy();

      return;
    }

    const outbound = httpRequest({
      createConnection: () => connection.socket,
      headers: forwardedHeaders(
        request.rawHeaders,
        connection.absoluteForm ? this.#proxyAuthorization : undefined,
      ),
      method: request.method,
      path: connection.absoluteForm ? url.href : `${url.pathname}${url.search}`,
      setHost: false,
    });

    outbound.once("response", (upstreamResponse) => {
      if (connection.absoluteForm && upstreamResponse.statusCode === 407 && this.#upstream) {
        upstreamResponse.resume();
        this.#recordFailure(target, proxyAuthFailed(this.#upstream));
        response.writeHead(502).end();

        return;
      }

      try {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.rawHeaders);
      } catch {
        upstreamResponse.destroy();
        outbound.destroy();
        response.destroy();

        return;
      }

      void relayBody(upstreamResponse, response, outbound);
    });
    outbound.once("error", () => {
      response.destroy();
    });
    response.once("close", () => {
      outbound.destroy();
    });
    request.pipe(outbound);
  }

  #recordFailure(target: Target, error: XrioError | undefined): void {
    if (error === undefined || this.#deadline.signal.aborted) {
      return;
    }

    if (PROXY_WIDE_FAILURES.has(error.code)) {
      this.#proxyFailure ??= error;
    } else if (!this.#hostFailures.has(target.hostname)) {
      this.#hostFailures.set(target.hostname, error);
    }
  }

  #refusesLocalTarget(target: Target): boolean {
    if (this.#upstream === undefined || !isLocalTarget(target.hostname)) {
      return false;
    }

    this.#recordFailure(
      target,
      networkError(
        `Refused to send the local address ${target.hostname} through the proxy ${this.#upstream.redactedUrl}.`,
      ),
    );

    return true;
  }

  async #dial(hostname: string, port: number, useTls: boolean): Promise<Socket> {
    using stage = this.#deadline.startStage(DIAL_TIMEOUT_MS);
    const host = unbracketed(hostname);

    const socket = this.track(
      useTls
        ? connectTls({
            allowHalfOpen: true,
            host,
            port,
            servername: isIP(host) === 0 ? host : undefined,
          })
        : connectTcp({ allowHalfOpen: true, host, port }),
    );

    try {
      await once(socket, useTls ? "secureConnect" : "connect", { signal: stage.signal });
    } catch (error) {
      socket.destroy();
      throw error;
    }

    return socket;
  }

  async #dialProxy(proxy: ProxyEndpoint): Promise<Socket> {
    try {
      return await this.#dial(proxy.hostname, proxy.port, proxy.protocol === "https");
    } catch (error) {
      this.#deadline.signal.throwIfAborted();
      throw proxyUnreachable(proxy, "Could not connect to the proxy", error);
    }
  }

  async #openTunnel(target: Target): Promise<Duplex> {
    const upstream = this.#upstream;

    if (upstream === undefined) {
      return await this.#connectDirectly(target);
    }

    return upstream.protocol === "socks5"
      ? await this.#connectThroughSocksProxy(upstream, target)
      : await this.#connectThroughHttpProxy(upstream, target);
  }

  async #openForwardingConnection(target: Target): Promise<ForwardingConnection> {
    const upstream = this.#upstream;

    const forwardsAbsoluteForm = upstream !== undefined && upstream.protocol !== "socks5";

    if (forwardsAbsoluteForm) {
      return { absoluteForm: true, socket: await this.#dialProxy(upstream) };
    }

    return { absoluteForm: false, socket: await this.#openTunnel(target) };
  }

  async #connectDirectly(target: Target): Promise<Duplex> {
    try {
      return await this.#dial(target.hostname, target.port, false);
    } catch (error) {
      this.#deadline.signal.throwIfAborted();
      throw networkError(`Could not connect to ${target.hostname}:${target.port}.`, error);
    }
  }

  async #connectThroughHttpProxy(proxy: ProxyEndpoint, target: Target): Promise<Duplex> {
    const socket = await this.#dialProxy(proxy);
    const authority = `${target.hostname}:${target.port}`;

    const authorization =
      this.#proxyAuthorization === undefined
        ? ""
        : `Proxy-Authorization: ${this.#proxyAuthorization}\r\n`;

    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`);

    const status = await this.#readConnectReply(socket, proxy, authority);
    const refusal = tunnelRefusal(proxy, authority, status);

    if (refusal !== undefined) {
      socket.destroy();
      throw refusal;
    }

    return socket;
  }

  async #readConnectReply(
    socket: Socket,
    proxy: ProxyEndpoint,
    authority: string,
  ): Promise<number> {
    using stage = this.#deadline.startStage(CONNECT_REPLY_TIMEOUT_MS);

    try {
      return await readReplyStatus(socket, stage.signal);
    } catch (error) {
      socket.destroy();
      this.#deadline.signal.throwIfAborted();
      throw stage.signal.aborted
        ? replyTimedOut(proxy, authority, error)
        : proxyUnreachable(proxy, "Expected an HTTP CONNECT reply from", error);
    }
  }

  async #connectThroughSocksProxy(proxy: ProxyEndpoint, target: Target): Promise<Duplex> {
    const socket = await this.#dialProxy(proxy);
    using stage = this.#deadline.startStage(CONNECT_REPLY_TIMEOUT_MS);

    const destroyOnAbort = () => {
      socket.destroy();
    };

    stage.signal.addEventListener("abort", destroyOnAbort, { once: true });

    try {
      const established = await SocksClient.createConnection({
        command: "connect",
        destination: { host: unbracketed(target.hostname), port: target.port },
        existing_socket: socket,
        proxy: {
          host: unbracketed(proxy.hostname),
          password: proxy.credentials?.password,
          port: proxy.port,
          type: 5,
          userId: proxy.credentials?.username,
        },
      });

      return this.track(established.socket);
    } catch (error) {
      socket.destroy();
      this.#deadline.signal.throwIfAborted();

      if (stage.signal.aborted) {
        throw replyTimedOut(
          proxy,
          `${target.hostname}:${target.port}`,
          new Error("SOCKS reply timed out"),
        );
      }

      throw socksFailure(
        proxy,
        target,
        error instanceof Error ? error : new Error("SOCKS failure"),
      );
    } finally {
      stage.signal.removeEventListener("abort", destroyOnAbort);
    }
  }
}

const listen = async (server: Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns either a TCP address, a pipe path, or null.
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The proxy relay did not receive a TCP port.");
  }

  return address.port;
};

export const startRelay = async (
  upstream: ProxyEndpoint | undefined,
  deadline: Deadline,
): Promise<Relay> => {
  const token = randomBytes(RELAY_TOKEN_BYTES).toString("hex");
  const relay = new ProxyRelay(upstream, deadline, token);
  const server = createServer();

  server.on("connection", (socket: Socket) => {
    relay.track(socket);
  });
  server.on("connect", (request: IncomingMessage, client: Duplex, head: Buffer) => {
    if (!relay.admits(request)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");

      return;
    }

    void relay.relayConnect(client, request.url, head);
  });
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    if (!relay.admits(request)) {
      response.writeHead(407).end();

      return;
    }

    void relay.relayRequest(request, response);
  });

  const port = await listen(server);

  return {
    [Symbol.asyncDispose]: async () => {
      const closed = once(server, "close");

      relay.destroySockets();
      server.close();
      await closed;
    },
    failureFor: (hostname) => relay.failureFor(hostname),
    url: `http://${RELAY_USER}:${token}@127.0.0.1:${port}`,
  };
};
