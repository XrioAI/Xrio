import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";

import { describe, expect, it } from "vite-plus/test";

import { inScrapeContext, publishInternalEvent, timeStage } from "./diagnostics.ts";

interface TaggedTiming {
  readonly stage: string;
  readonly scrapeId: string;
  readonly outcome: string;
}

const isTaggedTiming = (message: unknown): message is TaggedTiming =>
  typeof message === "object" &&
  message !== null &&
  "stage" in message &&
  typeof message.stage === "string" &&
  "scrapeId" in message &&
  typeof message.scrapeId === "string" &&
  "outcome" in message &&
  typeof message.outcome === "string";

const isTaggedEvent = (
  message: unknown,
): message is { readonly scrapeId: string; readonly detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "scrapeId" in message &&
  typeof message.scrapeId === "string" &&
  "detail" in message &&
  typeof message.detail === "string";

describe("scrape diagnostics", () => {
  it("keeps concurrent contexts separate through delayed teardown and events", async () => {
    const timings: TaggedTiming[] = [];
    const events: { readonly scrapeId: string; readonly detail: string }[] = [];

    const recordTiming: ChannelListener = (message) => {
      if (isTaggedTiming(message)) {
        timings.push(message);
      }
    };

    const recordEvent: ChannelListener = (message) => {
      if (isTaggedEvent(message)) {
        events.push({ detail: message.detail, scrapeId: message.scrapeId });
      }
    };

    const closing = Promise.withResolvers<"closed">();

    subscribe("xrio:stage", recordTiming);
    subscribe("xrio:event", recordEvent);

    try {
      const first = inScrapeContext("first", async () => {
        await timeStage("capture", async () => {
          await Promise.resolve();
        });
        await timeStage("teardown", async () => {
          await closing.promise;
        });
        publishInternalEvent({ detail: "first closed", event: "teardown-incomplete" });
      });

      const second = inScrapeContext("second", async () => {
        await timeStage("capture", async () => {
          await Promise.resolve();
        });
        publishInternalEvent({ detail: "second captured", event: "identity-chosen" });
      });

      await second;
      expect(
        timings.flatMap(({ stage, scrapeId }) => (stage === "capture" ? [scrapeId] : [])),
      ).toStrictEqual(["first", "second"]);
      expect(events).toStrictEqual([{ detail: "second captured", scrapeId: "second" }]);
      closing.resolve("closed");
      await first;
      expect(timings.at(-1)).toMatchObject({ outcome: "ok", scrapeId: "first", stage: "teardown" });
      expect(events.at(-1)).toStrictEqual({ detail: "first closed", scrapeId: "first" });
    } finally {
      closing.resolve("closed");
      unsubscribe("xrio:stage", recordTiming);
      unsubscribe("xrio:event", recordEvent);
    }
  });

  it("reports failed and aborted stages separately", async () => {
    const outcomes: string[] = [];

    const record: ChannelListener = (message) => {
      if (isTaggedTiming(message)) {
        outcomes.push(message.outcome);
      }
    };

    const failure = new Error("The stage failed.");

    subscribe("xrio:stage", record);

    try {
      await inScrapeContext("outcomes", async () => {
        await expect(timeStage("identity", async () => await Promise.reject(failure))).rejects.toBe(
          failure,
        );
        await expect(
          timeStage("navigation", async () => await Promise.reject(failure), {
            signal: AbortSignal.abort(failure),
          }),
        ).rejects.toBe(failure);
      });
      expect(outcomes).toStrictEqual(["failed", "aborted"]);
    } finally {
      unsubscribe("xrio:stage", record);
    }
  });
});
