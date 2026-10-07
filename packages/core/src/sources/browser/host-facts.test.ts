import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { CacheDir } from "../../cache-dir.ts";
import { startDeadline } from "../../deadline.ts";
import { dumpsRun, fakeForkPath } from "../../testing/fake-fork.ts";
import { hostFactsFor } from "./host-facts.ts";

const PROBE = fileURLToPath(new URL("../../testing/probe-host-facts.ts", import.meta.url));

const withRoot = async (work: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), "xrio-host-facts-"));

  try {
    await work(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe("process host facts", () => {
  it("probes a binary once for every client in the process that shares a cache directory", async () => {
    await withRoot(async (root) => {
      const binary = await fakeForkPath("kit", { root });
      const cacheDir = path.join(root, "cache");
      const first = hostFactsFor(new CacheDir(cacheDir));
      const second = hostFactsFor(new CacheDir(cacheDir));
      using deadline = startDeadline(10_000);

      const snapshots = await Promise.all([
        first.snapshotFor(binary, deadline),
        second.snapshotFor(binary, deadline),
      ]);

      expect(snapshots[1]).toStrictEqual(snapshots[0]);
      await expect(dumpsRun(binary)).resolves.toBe(1);
    });
  });

  it("shares a durable host cache across two real Node processes", async () => {
    await withRoot(async (root) => {
      const binary = await fakeForkPath("kit", { root });
      const cache = path.join(root, "cache");
      const first = execFileSync(process.execPath, [PROBE, cache, binary], { encoding: "utf-8" });
      const second = execFileSync(process.execPath, [PROBE, cache, binary], { encoding: "utf-8" });
      const firstSnapshot: unknown = JSON.parse(first);
      const secondSnapshot: unknown = JSON.parse(second);

      expect(firstSnapshot).toMatchObject({ fork: { version: "154.0.8037.57" } });
      expect(secondSnapshot).toStrictEqual(firstSnapshot);
      await expect(dumpsRun(binary)).resolves.toBe(1);

      const files = await readdir(path.join(cache, "host"));

      expect(files).toHaveLength(1);

      const stored: unknown = JSON.parse(
        await readFile(path.join(cache, "host", files[0] ?? ""), "utf-8"),
      );

      expect(stored).toMatchObject({ kind: "probed" });
    });
  });

  it("returns platform-only facts without a comparison binary or a cache write", async () => {
    await withRoot(async (root) => {
      using deadline = startDeadline(5000);

      await expect(
        hostFactsFor(new CacheDir(root)).snapshotFor(undefined, deadline),
      ).resolves.toMatchObject({ platform: process.platform });
      await expect(readdir(root)).resolves.toStrictEqual([]);
    });
  });
});
