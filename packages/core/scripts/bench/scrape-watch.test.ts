import { channel } from "node:diagnostics_channel";

import { describe, expect, it } from "vite-plus/test";

import { publishInternalEvent } from "../../src/diagnostics.ts";
import { watchScrape } from "./scrape-watch.ts";

const stages = channel("xrio:stage");

const timing = (stage: string, durationMs: number, scrapeId?: string) => ({
  durationMs,
  outcome: "ok",
  scrapeId,
  stage,
});

describe(watchScrape, () => {
  it("adds up a scrape's stages, skips sweeps outside a scrape and reports the launch", () => {
    const launched: number[] = [];

    const watch = watchScrape((pid) => {
      launched.push(pid);
    });

    stages.publish(timing("launch", 300, "scrape-1"));
    stages.publish(timing("challenge", 2, "scrape-1"));
    stages.publish(timing("challenge", 3, "scrape-1"));
    stages.publish(timing("scratch-sweep", 40));
    publishInternalEvent({
      detail: JSON.stringify(["--headless", "about:blank"]),
      event: "browser-argv",
    });
    publishInternalEvent({ detail: "4242", event: "browser-launched" });

    const observation = watch.stop();

    expect(observation.stagesMs).toStrictEqual({
      capture: 0,
      challenge: 5,
      identity: 0,
      launch: 300,
      navigation: 0,
      queue: 0,
      teardown: 0,
      verify: 0,
    });
    expect(observation.browserArgv).toStrictEqual([["--headless", "about:blank"]]);
    expect(observation.browserPids).toStrictEqual([4242]);
    expect(launched).toStrictEqual([4242]);
  });

  it("stops recording once stopped", () => {
    const watch = watchScrape(() => {
      throw new Error("no browser launched");
    });

    watch.stop();
    stages.publish(timing("launch", 300, "scrape-1"));

    expect(watch.stop().stagesMs.launch).toBe(0);
  });
});
