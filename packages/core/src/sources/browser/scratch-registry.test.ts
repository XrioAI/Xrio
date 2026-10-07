import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../../deadline.ts";
import { inScrapeContext } from "../../diagnostics.ts";
import { removeScratchDir } from "./browser-process.ts";
import { ScratchRegistry } from "./scratch-registry.ts";

const isEvent = (message: unknown): message is { event: string; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  typeof message.event === "string" &&
  "detail" in message &&
  typeof message.detail === "string";

const isSweepStage = (message: unknown): message is { stage: string; scrapeId: unknown } =>
  typeof message === "object" &&
  message !== null &&
  "stage" in message &&
  message.stage === "scratch-sweep" &&
  "scrapeId" in message;

describe(ScratchRegistry, () => {
  it("touches nothing under its root until the first scratch, then sweeps once outside the scrape", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "xrio-registry-"));
    const root = path.join(parent, "scratch");
    const sweeps: unknown[] = [];

    const record: ChannelListener = (message) => {
      if (isSweepStage(message)) {
        sweeps.push(message.scrapeId);
      }
    };

    subscribe("xrio:stage", record);

    try {
      const registry = new ScratchRegistry(root);

      await registry.settle();
      await expect(readdir(parent)).resolves.toStrictEqual([]);
      expect(sweeps).toStrictEqual([]);

      using deadline = startDeadline(5000);

      const scratches = await inScrapeContext(
        "first-scrape",
        async () => await Promise.all([registry.create(deadline), registry.create(deadline)]),
      );

      expect(sweeps).toStrictEqual([undefined]);
      await Promise.all(
        scratches.map(async (scratch) => {
          await removeScratchDir(scratch);
        }),
      );
    } finally {
      unsubscribe("xrio:stage", record);
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("sweeps once while a sweep runs, and creates scratch under its root after it", async () => {
    const root = path.join(await mkdtemp(path.join(tmpdir(), "xrio-registry-")), "scratch");

    try {
      const registry = new ScratchRegistry(root);

      expect(registry.sweep()).toBe(registry.sweep());
      using deadline = startDeadline(5000);
      const scratch = await registry.create(deadline);

      expect(path.dirname(scratch.path)).toBe(root);
      await removeScratchDir(scratch);
      await registry.settle();
      await expect(readdir(root)).resolves.toStrictEqual([]);
    } finally {
      await rm(path.dirname(root), { force: true, recursive: true });
    }
  });

  it("publishes a failed sweep and still settles", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "xrio-registry-"));
    const root = path.join(parent, "not-a-directory");
    const events: string[] = [];

    const record: ChannelListener = (message) => {
      if (isEvent(message) && message.event === "sweep-incomplete") {
        events.push(message.detail);
      }
    };

    subscribe("xrio:event", record);

    try {
      await writeFile(root, "");
      await new ScratchRegistry(root).sweep();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatch(/^The scratch sweep failed: /u);
    } finally {
      unsubscribe("xrio:event", record);
      await rm(parent, { force: true, recursive: true });
    }
  });
});
