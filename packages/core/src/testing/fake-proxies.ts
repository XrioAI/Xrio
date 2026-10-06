import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import type { Server, Socket } from "node:net";

import { listenOnLoopback } from "./fixture-server.ts";

export interface FakeProxy extends AsyncDisposable {
  readonly url: string;
  readonly requests: { authority: string; authorization: string | undefined }[];
}

export interface FakeProxyBehaviour {
  readonly tunnelTo: number;
  readonly connectStatus?: number;
  readonly requireCredentials?: string;
  readonly silent?: boolean;
  readonly secure?: boolean;
}

export const TEST_ONLY_CERT = readFileSync(new URL("test-only-cert.pem", import.meta.url));

const SOCKS_VERSION = 5;

const SOCKS_USERNAME_PASSWORD = 2;

const SOCKS_NO_AUTHENTICATION = 0;

const disposeServer = (server: Server, sockets: Set<Socket>) => async () => {
  const closed = once(server, "close");

  for (const socket of sockets) {
    socket.destroy();
  }

  server.close();
  await closed;
};

const trackSockets = (server: Server): Set<Socket> => {
  const sockets = new Set<Socket>();

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  return sockets;
};

const pipeBothWays = (left: Socket, right: Socket) => {
  left.once("close", () => {
    right.destroy();
  });
  right.once("close", () => {
    left.destroy();
  });
  left.pipe(right);
  right.pipe(left);
};

export const startFakeHttpProxy = async (behaviour: FakeProxyBehaviour): Promise<FakeProxy> => {
  const requests: FakeProxy["requests"] = [];

  const server =
    behaviour.secure === true
      ? createHttpsServer({
          cert: TEST_ONLY_CERT,
          key: readFileSync(new URL("test-only-key.pem", import.meta.url)),
        })
      : createServer();

  const sockets = trackSockets(server);

  const isAuthorized = (request: IncomingMessage) =>
    behaviour.requireCredentials === undefined ||
    request.headers["proxy-authorization"] ===
      `Basic ${Buffer.from(behaviour.requireCredentials).toString("base64")}`;

  server.on("connect", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    requests.push({
      authority: request.url ?? "",
      authorization: request.headers["proxy-authorization"],
    });

    if (behaviour.silent === true) {
      return;
    }

    const status = isAuthorized(request) ? (behaviour.connectStatus ?? 200) : 407;

    if (status !== 200) {
      socket.end(`HTTP/1.1 ${status} Fake\r\nContent-Length: 0\r\n\r\n`);

      return;
    }

    const upstream = connect(
      { allowHalfOpen: true, host: "127.0.0.1", port: behaviour.tunnelTo },
      () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        pipeBothWays(socket, upstream);
      },
    );

    upstream.on("error", () => {
      socket.destroy();
    });
  });

  server.on("request", (request, response) => {
    requests.push({
      authority: request.url ?? "",
      authorization: request.headers["proxy-authorization"],
    });

    if (!isAuthorized(request)) {
      response.writeHead(407).end();

      return;
    }

    const url = new URL(request.url ?? "");

    const forwarded = httpRequest(
      {
        headers: request.headers,
        host: "127.0.0.1",
        method: request.method,
        path: `${url.pathname}${url.search}`,
        port: behaviour.tunnelTo,
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      },
    );

    forwarded.on("error", () => {
      response.destroy();
    });
    request.pipe(forwarded);
  });

  const port = await listenOnLoopback(server);

  return {
    [Symbol.asyncDispose]: disposeServer(server, sockets),
    requests,
    url: `${behaviour.secure === true ? "https" : "http"}://127.0.0.1:${port}`,
  };
};

const readBytes = async (socket: Socket, count: number): Promise<Buffer> => {
  if (count === 0) {
    return Buffer.alloc(0);
  }

  const chunk: unknown = socket.read(count);

  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  await once(socket, "readable");

  return await readBytes(socket, count);
};

const readSocksDestination = async (socket: Socket): Promise<string> => {
  const request = await readBytes(socket, 4);
  const addressType = request.at(-1);

  if (addressType === 3) {
    const [length] = await readBytes(socket, 1);
    const host = await readBytes(socket, length);
    await readBytes(socket, 2);

    return host.toString("latin1");
  }

  const address = await readBytes(socket, addressType === 1 ? 4 : 16);
  await readBytes(socket, 2);

  return addressType === 1 ? address.join(".") : address.toString("hex");
};

const acceptsSocksCredentials = async (
  socket: Socket,
  requireCredentials: string | undefined,
): Promise<boolean> => {
  const [, methodCount] = await readBytes(socket, 2);
  await readBytes(socket, methodCount);

  if (requireCredentials === undefined) {
    socket.write(Buffer.from([SOCKS_VERSION, SOCKS_NO_AUTHENTICATION]));

    return true;
  }

  socket.write(Buffer.from([SOCKS_VERSION, SOCKS_USERNAME_PASSWORD]));
  const authentication = await readBytes(socket, 2);
  const username = await readBytes(socket, authentication[1]);
  const [passwordLength] = await readBytes(socket, 1);
  const password = await readBytes(socket, passwordLength);

  const accepted =
    `${username.toString("utf-8")}:${password.toString("utf-8")}` === requireCredentials;

  socket.write(Buffer.from([1, accepted ? 0 : 1]));

  return accepted;
};

const negotiateSocksTunnel = async (
  socket: Socket,
  behaviour: FakeProxyBehaviour,
  requests: FakeProxy["requests"],
) => {
  const accepted = await acceptsSocksCredentials(socket, behaviour.requireCredentials);

  if (!accepted) {
    socket.end();

    return;
  }

  requests.push({ authority: await readSocksDestination(socket), authorization: undefined });

  const reply = behaviour.connectStatus === undefined ? 0 : 4;
  socket.write(Buffer.from([SOCKS_VERSION, reply, 0, 1, 0, 0, 0, 0, 0, 0]));

  if (reply !== 0) {
    socket.end();

    return;
  }

  const upstream = connect(
    { allowHalfOpen: true, host: "127.0.0.1", port: behaviour.tunnelTo },
    () => {
      pipeBothWays(socket, upstream);
    },
  );

  upstream.on("error", () => {
    socket.destroy();
  });
};

const serveSocksClient = async (
  socket: Socket,
  behaviour: FakeProxyBehaviour,
  requests: FakeProxy["requests"],
) => {
  try {
    await negotiateSocksTunnel(socket, behaviour, requests);
  } catch {
    socket.destroy();
  }
};

export const startFakeSocksProxy = async (behaviour: FakeProxyBehaviour): Promise<FakeProxy> => {
  const requests: FakeProxy["requests"] = [];

  const server = createTcpServer({ allowHalfOpen: true }, (socket) => {
    void serveSocksClient(socket, behaviour, requests);
  });

  const sockets = trackSockets(server);
  const port = await listenOnLoopback(server);

  return {
    [Symbol.asyncDispose]: disposeServer(server, sockets),
    requests,
    url: `socks5://127.0.0.1:${port}`,
  };
};
