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

const closesAfterBrowserClose = async (args: readonly string[]) => {
  const fake = spawn(await fakeChromePath("fork"), args, {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });

  const exited = once(fake, "exit");

  pipeOf(fake.stdio[3]).write(`${JSON.stringify({ id: 1, method: "Browser.close" })}\0`);
  await exited;

  return { code: fake.exitCode, signal: fake.signalCode };
};

const refusalOf = async (args: readonly string[]) => {
  const fake = spawn(await fakeChromePath("fork"), args, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  });

  const exited = once(fake, "exit");
  const stderr = await text(pipeOf(fake.stdio[2]));

  await exited;

  return { code: fake.exitCode, stderr };
};

describe("the fake fork's seed check", () => {
  it.each(["--xrio-seed=0x063140f55c3932af", "--xrio-seed=1", "--xrio-seed=0xFFFFFFFFFFFFFFFF"])(
    "starts with %s, a seed the fork accepts",
    async (arg) => {
      await expect(closesAfterBrowserClose([arg])).resolves.toStrictEqual({
        code: 0,
        signal: null,
      });
    },
  );

  it.each([
    { arg: "--xrio-seed=0", seed: "0" },
    { arg: "--xrio-seed=0x0000000000000000", seed: "0x0000000000000000" },
    { arg: "--xrio-seed=0x10000000000000000", seed: "0x10000000000000000" },
    { arg: "--xrio-seed=18446744073709551616", seed: "18446744073709551616" },
    { arg: "--xrio-seed=063140f55c3932af", seed: "063140f55c3932af" },
    { arg: "--xrio-seed", seed: "" },
  ])("refuses to start with $arg, as the fork does", async ({ arg, seed }) => {
    await expect(refusalOf([arg])).resolves.toStrictEqual({
      code: 1,
      stderr: `--xrio-seed must be a non-zero seed (decimal, or 0x-prefixed hex), not ${JSON.stringify(seed)}\n`,
    });
  });
});

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
