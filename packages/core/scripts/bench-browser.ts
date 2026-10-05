import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { startDeadline } from "../src/deadline.ts";
import { readHostZone } from "../src/humanizer/host-zone.ts";
import { planIdentity } from "../src/humanizer/humanizer.ts";
import { createCapabilityProbe } from "../src/sources/browser/capabilities.ts";
import { cdpDriver } from "../src/sources/browser/cdp/driver.ts";
import { planLaunch } from "../src/sources/browser/launch-plan.ts";
import { chromePath } from "../src/testing/chrome-path.ts";
import { conformancePages } from "../src/testing/conformance-pages.ts";
import { fixedDevice, fixedRandom } from "../src/testing/fixed-seed.ts";
import { startFixtureServer } from "../src/testing/fixture-server.ts";
import { noPins } from "../src/testing/no-pins.ts";
import { plannedScrapes } from "../src/testing/planned-scrapes.ts";

const SCRAPE_TIMEOUT_MS = 30_000;

const PERCENTILES = [50, 95] as const;

const MEASURES = [
  "identity",
  "launch",
  "verify",
  "navigation",
  "capture",
  "teardown",
  "answer",
  "exit",
] as const;

type Measure = (typeof MEASURES)[number];

type Sample = Record<Measure, number>;

const { values } = parseArgs({
  options: {
    mode: { default: "headless", type: "string" },
    out: { type: "string" },
    route: { default: "/static", type: "string" },
    runs: { default: "10", type: "string" },
  },
});

const parseMode = (value: string): "headless" | "headed" => {
  if (value !== "headless" && value !== "headed") {
    throw new Error(`--mode must be headless or headed, not "${value}".`);
  }

  return value;
};

const parseRuns = (value: string): number => {
  const runs = Number(value);

  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--runs must be a positive integer, not "${value}".`);
  }

  return runs;
};

const mode = parseMode(values.mode);

const runs = parseRuns(values.runs);

const isStageTiming = (message: unknown): message is { stage: string; durationMs: number } =>
  typeof message === "object" &&
  message !== null &&
  "stage" in message &&
  typeof message.stage === "string" &&
  "durationMs" in message &&
  typeof message.durationMs === "number";

const isMeasure = (stage: string): stage is Measure => MEASURES.some((name) => name === stage);

const sha256Of = async (file: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");

const server = await startFixtureServer(conformancePages);

const scrapeOnce = async (): Promise<Sample> => {
  const sample: Sample = {
    answer: 0,
    capture: 0,
    exit: 0,
    identity: 0,
    launch: 0,
    navigation: 0,
    teardown: 0,
    verify: 0,
  };

  const record: ChannelListener = (message) => {
    if (isStageTiming(message) && isMeasure(message.stage)) {
      sample[message.stage] = message.durationMs;
    }
  };

  subscribe("xrio:stage", record);
  const browsers = plannedScrapes(cdpDriver, 1, { random: fixedRandom });
  const started = performance.now();

  try {
    using deadline = startDeadline(SCRAPE_TIMEOUT_MS);

    await browsers.visit({
      browserArgs: [],
      browserPath: chromePath(),
      deadline,
      mode,
      pins: noPins,
      proxy: undefined,
      url: new URL(values.route, server.origin),
    }).document;
    sample.answer = performance.now() - started;
  } finally {
    await browsers.close();
    sample.exit = performance.now() - started;
    unsubscribe("xrio:stage", record);
  }

  return sample;
};

const percentile = (sorted: readonly number[], rank: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1)] ?? Number.NaN;

const summarise = (samples: readonly Sample[]) =>
  Object.fromEntries(
    MEASURES.map((measure) => {
      const sorted = samples.map((sample) => sample[measure]).toSorted((a, b) => a - b);

      return [
        measure,
        Object.fromEntries(
          PERCENTILES.map((rank) => [`p${rank}`, Number(percentile(sorted, rank).toFixed(1))]),
        ),
      ];
    }),
  );

const samples: Sample[] = [];

for (let run = 0; run < runs; run += 1) {
  // oxlint-disable-next-line eslint/no-await-in-loop
  samples.push(await scrapeOnce());
}

await server[Symbol.asyncDispose]();

const { args } = planLaunch({
  browserArgs: [],
  browserPath: chromePath(),
  display: process.env.DISPLAY,
  headless: mode === "headless",
  identity: planIdentity({
    capabilities: await createCapabilityProbe()(chromePath()),
    device: fixedDevice,
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: readHostZone(),
    mode,
    pins: noPins,
  }).inputs,
  scratchDir: "<scratch>",
  xauthority: process.env.XAUTHORITY,
});

const report = {
  config: {
    argv: args,
    browserPath: chromePath(),
    browserSha256: await sha256Of(chromePath()),
    mode,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    route: values.route,
    runs,
  },
  results: { samples, summary: summarise(samples) },
};

if (values.out !== undefined) {
  await writeFile(values.out, `${JSON.stringify(report, undefined, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(report.results.summary, undefined, 2)}\n`);
