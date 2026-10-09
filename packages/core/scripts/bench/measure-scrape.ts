import { XrioClient } from "../../src/client.ts";
import { startUsageMeter } from "./process-usage.ts";
import type { UsageMeter, UsageReport } from "./process-usage.ts";
import { watchScrape } from "./scrape-watch.ts";
import type { ScrapeObservation, ScrapeWatch } from "./scrape-watch.ts";
import type { Metrics } from "./summary.ts";

const SCRAPE_TIMEOUT_MS = 30_000;

const HTTP_ERROR_FLOOR = 400;

export interface ScrapeTarget {
  readonly label: string;
  readonly url: string;
}

export interface ScrapeSettings {
  readonly mode: "headless" | "headed";
  readonly browserPath: string;
}

export interface MeasuredScrape {
  readonly status: number;
  readonly browserArgv: readonly string[];
  readonly browserProcesses: number | null;
  readonly metrics: Metrics;
}

interface Answer {
  readonly answerMs: number;
  readonly status: number;
}

interface ClosedScrape extends Answer {
  readonly exitMs: number;
  readonly observation: ScrapeObservation;
  readonly usage: UsageReport;
}

const answerThenClose = async (
  client: XrioClient,
  url: string,
  meter: UsageMeter,
  watch: ScrapeWatch,
): Promise<ClosedScrape> => {
  const started = performance.now();
  let answer: Answer;
  let observation: ScrapeObservation;
  let usage: UsageReport;

  try {
    const { status } = await client.scrape({ format: "html", timeoutMs: SCRAPE_TIMEOUT_MS, url });

    answer = { answerMs: performance.now() - started, status };
    meter.sample();
  } finally {
    try {
      await client.close();
    } finally {
      observation = watch.stop();
      usage = meter.finish();
    }
  }

  return { ...answer, exitMs: performance.now() - started, observation, usage };
};

const singleLaunch = (launches: readonly (readonly string[])[]): readonly string[] => {
  const [only, ...extra] = launches;

  if (only === undefined || extra.length > 0) {
    throw new Error(
      `A sample must launch Chrome once, but saw ${launches.length} browser-argv events.`,
    );
  }

  return only;
};

export const measureScrape = async (
  target: ScrapeTarget,
  settings: ScrapeSettings,
): Promise<MeasuredScrape> => {
  const meter = startUsageMeter();
  const watch = watchScrape(meter.followBrowser);

  const client = new XrioClient({
    browserPath: settings.browserPath,
    mode: settings.mode,
  });

  const { answerMs, exitMs, observation, status, usage } = await answerThenClose(
    client,
    target.url,
    meter,
    watch,
  );

  if (status >= HTTP_ERROR_FLOOR) {
    throw new Error(`${target.url} answered ${status}, so its timings measure an error page.`);
  }

  const { stagesMs } = observation;

  return {
    browserArgv: singleLaunch(observation.browserArgv),
    browserProcesses: usage.browser?.processes ?? null,
    metrics: {
      ...stagesMs,
      answer: answerMs,
      browserCpuSeconds: usage.browser?.cpuSeconds ?? null,
      browserPeakRssMib: usage.browser?.peakRssMib ?? null,
      combinedPeakRssMib: usage.combinedPeakRssMib,
      exit: exitMs,
      fixedOverhead: answerMs - stagesMs.navigation - stagesMs.challenge,
      nodeCpuSeconds: usage.nodeCpuSeconds,
      nodePeakRssMib: usage.nodePeakRssMib,
    },
    status,
  };
};
