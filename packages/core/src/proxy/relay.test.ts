import { once } from "node:events";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { listenOnLoopback } from "../testing/fixture-server.ts";
import { startRelay } from "./relay.ts";

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
    await using relay = await startRelay(startDeadline(10_000));
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

  it("refuses local clients that do not present the relay's token", async () => {
    await using relay = await startRelay(startDeadline(10_000));
    const reply = await readAll(await sendConnect(relay.url, `127.0.0.1:${echoPort}`, "", false));

    expect(statusOf(reply)).toBe(407);
  });

  it("refuses a token of the right length that does not match", async () => {
    await using relay = await startRelay(startDeadline(10_000));
    const forged = new URL(relay.url);

    forged.password = "0".repeat(forged.password.length);

    const reply = await readAll(await sendConnect(forged.href, `127.0.0.1:${echoPort}`));

    expect(statusOf(reply)).toBe(407);
  });
});
