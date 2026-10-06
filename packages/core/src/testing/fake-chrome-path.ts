import { createHash } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_CHROME = fileURLToPath(new URL("fake-chrome.ts", import.meta.url));

const PIPE_TEE_CHROME = fileURLToPath(new URL("pipe-tee-chrome.ts", import.meta.url));

const CHECKOUT = createHash("sha256").update(FAKE_CHROME).digest("hex").slice(0, 16);

export const fakeChromePath = async (scenario: string): Promise<string> => {
  const directory = path.join(tmpdir(), `xrio-fake-chrome-${process.getuid?.() ?? 0}-${CHECKOUT}`);
  const executable = path.join(directory, `chrome-${scenario}`);
  const staged = `${executable}.${process.pid}.tmp`;

  await mkdir(directory, { mode: 0o700, recursive: true });
  await writeFile(
    staged,
    `#!/bin/sh\nexec env XRIO_FAKE_SCENARIO=${scenario} "${process.execPath}" "${FAKE_CHROME}" "$@"\n`,
  );
  await chmod(staged, 0o755);
  await rename(staged, executable);

  return executable;
};

export const pipeTeeChromePath = async (
  chrome: string,
  directory: string,
): Promise<{ executable: string; log: string }> => {
  const executable = path.join(directory, "chrome-pipe-tee");
  const log = path.join(directory, "pipe-frames.jsonl");

  await writeFile(
    executable,
    `#!/bin/sh\nexec env XRIO_TEE_CHROME=${JSON.stringify(chrome)} XRIO_TEE_LOG=${JSON.stringify(log)} "${process.execPath}" "${PIPE_TEE_CHROME}" "$@"\n`,
  );
  await chmod(executable, 0o755);

  return { executable, log };
};
