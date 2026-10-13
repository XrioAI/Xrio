import { writeFile } from "node:fs/promises";

import { chromePath } from "../src/testing/chrome-path.ts";
import { conformancePages } from "../src/testing/conformance-pages.ts";
import { startFixtureServer } from "../src/testing/fixture-server.ts";
import { describeEnvironment } from "./bench/environment.ts";
import { createLaunchLedger, drawnValuesOf } from "./bench/launch-ledger.ts";
import { measureScrape } from "./bench/measure-scrape.ts";
import type { ScrapeSettings, ScrapeTarget } from "./bench/measure-scrape.ts";
import { readBenchOptions } from "./bench/options.ts";
import type { BenchOptions } from "./bench/options.ts";
import { summarise } from "./bench/summary.ts";
import type { Measured } from "./bench/summary.ts";

interface Sample extends Measured {
  readonly status: number;
  readonly drawnFlags: readonly string[];
  readonly browserProcesses: number | null;
}

const warmUp = async (
  target: ScrapeTarget,
  settings: ScrapeSettings,
  scrapes: number,
): Promise<void> => {
  for (let scrape = 0; scrape < scrapes; scrape += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await measureScrape(target, settings);
  }
};

const measureTargets = async (
  targets: readonly ScrapeTarget[],
  settings: ScrapeSettings,
  options: BenchOptions,
) => {
  const launches = createLaunchLedger();
  const samples: Sample[] = [];

  const [first] = targets;

  if (first !== undefined) {
    await warmUp(first, settings, options.warmup);
  }

  for (const target of targets) {
    for (let run = 0; run < options.runs; run += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const { browserArgv, ...measured } = await measureScrape(target, settings);

      launches.admit(browserArgv);
      samples.push({ ...measured, drawnFlags: drawnValuesOf(browserArgv), target: target.label });
    }
  }

  return { argv: launches.agreedArgv(), samples };
};

const benchmark = async (targets: readonly ScrapeTarget[], options: BenchOptions) => {
  const browserPath = chromePath();

  const settings: ScrapeSettings = {
    browserArgs: options.browserArgs,
    browserPath,
    mode: options.mode,
    proxy: options.proxy,
  };

  const { argv, samples } = await measureTargets(targets, settings, options);

  return {
    config: {
      argv,
      browserArgs: options.browserArgs,
      environment: describeEnvironment(browserPath),
      mode: options.mode,
      proxied: options.proxy !== undefined,
      runs: options.runs,
      targets: targets.map(({ label }) => label),
      warmup: options.warmup,
    },
    results: { samples, summary: summarise(samples) },
  };
};

const options = await readBenchOptions();

const report = await (async () => {
  if (options.liveUrls !== undefined) {
    return await benchmark(
      options.liveUrls.map((url) => ({ label: url, url })),
      options,
    );
  }

  await using server = await startFixtureServer(conformancePages);

  return await benchmark(
    [{ label: options.route, url: new URL(options.route, server.origin).href }],
    options,
  );
})();

if (options.out !== undefined) {
  await writeFile(options.out, `${JSON.stringify(report, undefined, 2)}\n`);
}

process.stdout.write(`${JSON.stringify(report.results.summary, undefined, 2)}\n`);
