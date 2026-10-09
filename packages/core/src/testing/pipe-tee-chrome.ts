import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Socket } from "node:net";
import { Readable, Writable } from "node:stream";

const chrome = process.env.XRIO_TEE_CHROME;

const log = process.env.XRIO_TEE_LOG;

if (chrome === undefined || log === undefined) {
  throw new Error("The pipe tee needs XRIO_TEE_CHROME and XRIO_TEE_LOG.");
}

const teeFrames = (direction: string, from: Readable, to: Writable) => {
  let buffered = "";

  from.setEncoding("utf-8");
  from.on("data", (chunk: string) => {
    buffered += chunk;
    let end = buffered.indexOf("\0");

    while (end !== -1) {
      appendFileSync(log, `${JSON.stringify({ direction, frame: buffered.slice(0, end) })}\n`);
      buffered = buffered.slice(end + 1);
      end = buffered.indexOf("\0");
    }

    to.write(chunk);
  });
  from.once("end", () => {
    to.end();
  });
};

const child = spawn(chrome, process.argv.slice(2), {
  stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"],
});

const { 3: toChrome, 4: fromChrome } = child.stdio;

if (!(toChrome instanceof Writable) || !(fromChrome instanceof Readable)) {
  throw new Error("Chrome's debugging pipe did not open.");
}

teeFrames("to-chrome", new Socket({ fd: 3, writable: false }), toChrome);

teeFrames("from-chrome", fromChrome, new Socket({ fd: 4, readable: false }));

child.once("exit", (code) => {
  process.exit(code ?? 1);
});
