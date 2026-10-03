import { spawn } from "node:child_process";
import { once } from "node:events";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vite-plus/test";

import { fakeChromePath } from "./fake-chrome-path.ts";

const pipeOf = (stream: Readable | Writable | null | undefined): Socket => {
  if (!(stream instanceof Socket)) {
    throw new TypeError("The fake browser's CDP pipe is not a socket.");
  }

  return stream;
};

describe("the fake browser", () => {
  it("exits once it answers Browser.close, while Xrio still holds its pipes open", async () => {
    const fake = spawn(await fakeChromePath("normal"), [], {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });

    const exited = once(fake, "exit");
    const replies = text(pipeOf(fake.stdio[4]));

    pipeOf(fake.stdio[3]).write(`${JSON.stringify({ id: 1, method: "Browser.close" })}\0`);

    await expect(exited).resolves.toStrictEqual([0, null]);
    await expect(replies).resolves.toBe(`${JSON.stringify({ id: 1, result: {} })}\0`);
  });
});
