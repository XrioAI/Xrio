import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { startDeadline } from "../src/deadline.ts";
import { createBrowsers } from "../src/sources/browser/browsers.ts";
import { BROWSER_DRIVERS, isBrowserDriverName } from "../src/sources/browser/drivers.ts";
import { planLaunch } from "../src/sources/browser/launch-plan.ts";
import type { BrowserDriver } from "../src/sources/browser/port.ts";
import { chromePath } from "../src/testing/chrome-path.ts";
import { conformancePages } from "../src/testing/conformance-pages.ts";
import { startFixtureServer } from "../src/testing/fixture-server.ts";

const SCRAPE_TIMEOUT_MS = 30_000;

const PERCENTILES = [50, 95] as const;

const MEASURES = ["launch", "navigation", "capture", "teardown", "answer", "exit"] as const;

type Measure = (typeof MEASURES)[number];

type Sample = Record<Measure, number>;

const { values } = parseArgs({
  options: {
    drivers: { default: Object.keys(BROWSER_DRIVERS).join(","), type: "string" },
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

const requestedDrivers = values.drivers.split(",");

const unknownDrivers = requestedDrivers.filter((name) => !isBrowserDriverName(name));

if (unknownDrivers.length > 0) {
  throw new Error(`Unknown drivers: ${unknownDrivers.join(", ")}`);
}

const driverNames = requestedDrivers.filter(isBrowserDriverName);

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

const hasVersion = (manifest: unknown): manifest is { version: string } =>
  typeof manifest === "object" &&
  manifest !== null &&
  "version" in manifest &&
  typeof manifest.version === "string";

const packageVersion = async (name: string): Promise<string> => {
  const manifest: unknown = JSON.parse(
    await readFile(new URL(import.meta.resolve(`${name}/package.json`)), "utf-8"),
  );

  return hasVersion(manifest) ? manifest.version : "unknown";
};

const server = await startFixtureServer(conformancePages);

const scrapeOnce = async (driver: BrowserDriver): Promise<Sample> => {
  const sample: Sample = { answer: 0, capture: 0, exit: 0, launch: 0, navigation: 0, teardown: 0 };

  const record: ChannelListener = (message) => {
    if (isStageTiming(message) && isMeasure(message.stage)) {
      sample[message.stage] = message.durationMs;
    }
  };

  subscribe("xrio:stage", record);
  const browsers = createBrowsers(driver, 1);
  const started = performance.now();

  try {
    using deadline = startDeadline(SCRAPE_TIMEOUT_MS);

    await browsers.load({
      browserPath: chromePath(),
      deadline,
      mode,
      proxy: undefined,
      url: new URL(values.route, server.origin),
    });
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

const samples = new Map<string, Sample[]>(driverNames.map((name) => [name, []]));

for (let run = 0; run < runs; run += 1) {
  const order = run % 2 === 0 ? driverNames : driverNames.toReversed();

  for (const name of order) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    samples.get(name)?.push(await scrapeOnce(BROWSER_DRIVERS[name]));
  }
}

await server[Symbol.asyncDispose]();

const { args } = planLaunch({
  browserPath: chromePath(),
  display: process.env.DISPLAY,
  headless: mode === "headless",
  platform: process.platform,
  scratchDir: "<scratch>",
  timezone: process.env.TZ,
  xauthority: process.env.XAUTHORITY,
});

const report = {
  config: {
    argv: args,
    browserPath: chromePath(),
    browserSha256: await sha256Of(chromePath()),
    mode,
    node: process.version,
    patchrightCore: await packageVersion("patchright-core"),
    platform: `${process.platform}-${process.arch}`,
    route: values.route,
    runs,
  },
  results: Object.fromEntries(
    [...samples].map(([name, driverSamples]) => [
      name,
      { samples: driverSamples, summary: summarise(driverSamples) },
    ]),
  ),
};

if (values.out !== undefined) {
  await writeFile(values.out, `${JSON.stringify(report, undefined, 2)}\n`);
}

process.stdout.write(
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries(report.results).map(([name, result]) => [name, result.summary]),
    ),
    undefined,
    2,
  )}\n`,
);
