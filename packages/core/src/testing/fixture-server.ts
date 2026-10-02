import { once } from "node:events";
import { createServer } from "node:http";
import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:net";

export interface FixtureOrigins {
  readonly origin: string;
  readonly crossOrigin: string;
}

export type FixtureHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  origins: FixtureOrigins,
) => void;

export interface FixtureServer extends FixtureOrigins, AsyncDisposable {}

const listenOnLoopback = async (server: Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns either a TCP address, a pipe path, or null.
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not receive a TCP port.");
  }

  return address.port;
};

const listen = async (server: Server): Promise<string> =>
  `http://127.0.0.1:${await listenOnLoopback(server)}`;

const close = async (server: HttpServer): Promise<void> => {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
};

export const startFixtureServer = async (handler: FixtureHandler): Promise<FixtureServer> => {
  const servers = [createServer(), createServer()];
  const [origin, loopbackCrossOrigin] = await Promise.all(servers.map(listen));
  const origins = { crossOrigin: loopbackCrossOrigin.replace("127.0.0.1", "localhost"), origin };

  for (const server of servers) {
    server.on("request", (request: IncomingMessage, response: ServerResponse) => {
      handler(request, response, origins);
    });
  }

  return {
    ...origins,
    [Symbol.asyncDispose]: async () => {
      await Promise.all(servers.map(close));
    },
  };
};
