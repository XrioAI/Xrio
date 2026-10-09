import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { profileUse } from "../sources/browser/browser-process.ts";
import {
  ensurePrivateDirectory,
  holderIsGone,
  processStart,
  profileDirectory,
} from "./profiles.ts";

const unreadableStart = async (): Promise<undefined> => {
  await Promise.resolve();
};

describe("profiles", () => {
  it("creates private profile directories and refuses public or symlink directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-profiles-"));
    const directory = path.join(root, "private");

    try {
      await ensurePrivateDirectory(directory);
      const stats = await lstat(directory);
      expect(stats.mode % 0o1000).toBe(0o700);
      await chmod(directory, 0o755);
      await expect(ensurePrivateDirectory(directory)).rejects.toThrow("0700");
      const link = path.join(root, "link");
      await symlink(directory, link);
      await expect(ensurePrivateDirectory(link)).rejects.toThrow("0700");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("hashes the tenant and session name without exposing either in the profile path", () => {
    expect(profileDirectory("/state", "local", "account")).toBe("/state/profiles/34b999a96c2c821a");
    expect(profileDirectory("/state", "other", "account")).not.toBe(
      profileDirectory("/state", "local", "account"),
    );
  });

  it("identifies PID reuse and keeps an unobservable remote holder protected", async () => {
    const start = await processStart(process.pid);
    expect(start).toMatch(/\S/u);
    const own = start ?? "";
    const holder = { host: hostname(), pid: process.pid, start: own, token: "test" };
    await expect(holderIsGone(holder, own)).resolves.toBeFalsy();
    await expect(holderIsGone({ ...holder, start: "different-start" }, own)).resolves.toBeTruthy();
    await expect(
      holderIsGone({ ...holder, host: "unobservable-remote-host" }, own),
    ).resolves.toBeFalsy();
  });

  it.each([{ TZ: "UTC" }, { LC_ALL: "de_DE.UTF-8", TZ: "Pacific/Kiritimati" }])(
    "reads the start a live holder recorded under %o",
    async (environment) => {
      const moduleUrl = new URL("profiles.ts", import.meta.url).href;

      const code = `import { processStart } from ${JSON.stringify(moduleUrl)};
        process.stdout.write((await processStart(process.pid)) ?? "unknown");
        setInterval(() => {}, 1000);`;

      const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "ignore"],
      });

      const exited = once(child, "exit");

      try {
        const output: unknown[] = await once(child.stdout, "data");
        const start = String(output[0]);
        const pid = child.pid ?? 0;
        const own = (await processStart(process.pid)) ?? "";
        const holder = { host: hostname(), pid, start, token: "holder" };

        expect({
          gone: await holderIsGone(holder, own),
          read: await processStart(pid),
        }).toStrictEqual({ gone: false, read: start });
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
    },
  );

  it("finds a profile path containing spaces without signalling its owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio profile spaces "));
    const directory = path.join(root, "profile with spaces");

    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.stdout.write('ready'); setInterval(() => {}, 1000)",
        "--",
        `--user-data-dir=${directory}`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const exited = once(child, "exit");
    using deadline = startDeadline(10_000);

    try {
      await once(child.stdout, "data");
      await expect(profileUse(directory, deadline)).resolves.toBe("in-use");
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      await expect(profileUse(path.join(root, "different profile"), deadline)).resolves.toBe(
        "clear",
      );
    } finally {
      child.kill("SIGTERM");
      await exited;
      await rm(root, { force: true, recursive: true });
    }
  }, 15_000);

  it("reports an unknown start instead of terminating Node when ps cannot start", async () => {
    const moduleUrl = new URL("profiles.ts", import.meta.url).href;

    const code = `import { processStart } from ${JSON.stringify(moduleUrl)};
      Object.defineProperty(process, "platform", { value: "darwin" });
      const start = await processStart(process.pid);
      process.stdout.write(start ?? "unknown");`;

    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, PATH: "/no-process-tools" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const [output, errors] = await Promise.all([
      text(child.stdout),
      text(child.stderr),
      once(child, "close"),
    ]);

    expect({ code: child.exitCode, errors, output }).toStrictEqual({
      code: 0,
      errors: "",
      output: "unknown",
    });
  });

  it("keeps a live holder protected when its process start cannot be read", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });

    const exited = once(child, "exit");
    const holder = { host: hostname(), pid: child.pid ?? 0, start: "recorded", token: "owner" };

    try {
      await expect(holderIsGone(holder, "own-start", unreadableStart)).resolves.toBeFalsy();
      await expect(
        holderIsGone(holder, "own-start", async () => await Promise.resolve("different-start")),
      ).resolves.toBeTruthy();
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  });
});
