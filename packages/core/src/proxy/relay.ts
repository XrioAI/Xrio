import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, Server, ServerResponse } from "node:http";
import { connect as connectTcp, Socket } from "node:net";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Deadline } from "../deadline.ts";
import { XrioError } from "../errors.ts";

const DIAL_TIMEOUT_MS = 10_000;

const IPV6_BRACKETS = /^\[|\]$/gu;

const AUTHORITY_WITH_PORT = /:\d+$/u;

const HOP_BY_HOP_PROXY_HEADERS = new Set(["proxy-authorization", "proxy-connection"]);

const RELAY_USER = "xrio";

const RELAY_TOKEN_BYTES = 16;

interface Target {
  hostname: string;
  port: number;
}

export interface Relay extends AsyncDisposable {
  readonly url: string;
  readonly failureFor: (hostname: string) => XrioError | undefined;
}

const unbracketed = (hostname: string): string => hostname.replaceAll(IPV6_BRACKETS, "");

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

const forwardedHeaders = (rawHeaders: string[]): string[] => {
  const headers: string[] = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];

    if (!HOP_BY_HOP_PROXY_HEADERS.has(name.toLowerCase())) {
      headers.push(name, rawHeaders[index + 1]);
    }
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

class ProxyRelay {
  readonly #deadline: Deadline;
  readonly #clientAuthorization: Buffer;
  readonly #sockets = new Set<Duplex>();
  readonly #hostFailures = new Map<string, XrioError>();

  constructor(deadline: Deadline, token: string) {
    this.#deadline = deadline;
    this.#clientAuthorization = Buffer.from(basicAuthorization(RELAY_USER, token));
  }

  admits(request: IncomingMessage): boolean {
    const presented = Buffer.from(request.headers["proxy-authorization"] ?? "");

    return (
      presented.byteLength === this.#clientAuthorization.byteLength &&
      timingSafeEqual(presented, this.#clientAuthorization)
    );
  }

  failureFor(hostname: string): XrioError | undefined {
    return this.#hostFailures.get(hostname);
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

    let tunnel: Duplex;

    try {
      tunnel = await this.#connectDirectly(target);
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
    let socket: Duplex;

    try {
      socket = await this.#connectDirectly(target);
    } catch (error) {
      this.#recordFailure(target, error instanceof XrioError ? error : undefined);
      response.writeHead(502).end();

      return;
    }

    if (response.destroyed) {
      socket.destroy();

      return;
    }

    const outbound = httpRequest({
      createConnection: () => socket,
      headers: forwardedHeaders(request.rawHeaders),
      method: request.method,
      path: `${url.pathname}${url.search}`,
      setHost: false,
    });

    outbound.once("response", (upstreamResponse) => {
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

    if (!this.#hostFailures.has(target.hostname)) {
      this.#hostFailures.set(target.hostname, error);
    }
  }

  async #dial(hostname: string, port: number): Promise<Socket> {
    using stage = this.#deadline.startStage(DIAL_TIMEOUT_MS);

    const socket = this.track(
      connectTcp({ allowHalfOpen: true, host: unbracketed(hostname), port }),
    );

    try {
      await once(socket, "connect", { signal: stage.signal });
    } catch (error) {
      socket.destroy();
      throw error;
    }

    return socket;
  }

  async #connectDirectly(target: Target): Promise<Duplex> {
    try {
      return await this.#dial(target.hostname, target.port);
    } catch (error) {
      this.#deadline.signal.throwIfAborted();
      throw networkError(`Could not connect to ${target.hostname}:${target.port}.`, error);
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

export const startRelay = async (deadline: Deadline): Promise<Relay> => {
  const token = randomBytes(RELAY_TOKEN_BYTES).toString("hex");
  const relay = new ProxyRelay(deadline, token);
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
