import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";

export const SCRAPE_STAGES = [
  "queue",
  "identity",
  "launch",
  "verify",
  "navigation",
  "challenge",
  "capture",
  "teardown",
] as const;

export type ScrapeStage = (typeof SCRAPE_STAGES)[number];

export interface ScrapeObservation {
  readonly stagesMs: Record<ScrapeStage, number>;
  readonly browserArgv: readonly (readonly string[])[];
  readonly browserPids: readonly number[];
}

interface StageTiming {
  readonly stage: ScrapeStage;
  readonly durationMs: number;
}

interface InternalEvent {
  readonly event: string;
  readonly detail: string;
}

const isScrapeStage = (stage: string): stage is ScrapeStage =>
  SCRAPE_STAGES.some((name) => name === stage);

const isStageTiming = (message: unknown): message is StageTiming =>
  typeof message === "object" &&
  message !== null &&
  "stage" in message &&
  typeof message.stage === "string" &&
  isScrapeStage(message.stage) &&
  "scrapeId" in message &&
  typeof message.scrapeId === "string" &&
  "durationMs" in message &&
  typeof message.durationMs === "number";

const isInternalEvent = (message: unknown): message is InternalEvent =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  typeof message.event === "string" &&
  "detail" in message &&
  typeof message.detail === "string";

const argvOf = (detail: string): string[] => {
  const parsed: unknown = JSON.parse(detail);

  if (!Array.isArray(parsed)) {
    throw new TypeError(`browser-argv carried ${detail}, which is not a list.`);
  }

  return parsed.map(String);
};

const pidOf = (detail: string): number => {
  const pid = Number(detail);

  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error(`browser-launched carried "${detail}", which is not a pid.`);
  }

  return pid;
};

const emptyStages = (): Record<ScrapeStage, number> => ({
  capture: 0,
  challenge: 0,
  identity: 0,
  launch: 0,
  navigation: 0,
  queue: 0,
  teardown: 0,
  verify: 0,
});

export const watchScrape = (onBrowserLaunched: (pid: number) => void) => {
  const stagesMs = emptyStages();
  const browserArgv: string[][] = [];
  const browserPids: number[] = [];

  const onStage: ChannelListener = (message) => {
    if (isStageTiming(message)) {
      stagesMs[message.stage] += message.durationMs;
    }
  };

  const onEvent: ChannelListener = (message) => {
    if (!isInternalEvent(message)) {
      return;
    }

    if (message.event === "browser-argv") {
      browserArgv.push(argvOf(message.detail));
    }

    if (message.event === "browser-launched") {
      const pid = pidOf(message.detail);

      browserPids.push(pid);
      onBrowserLaunched(pid);
    }
  };

  subscribe("xrio:stage", onStage);
  subscribe("xrio:event", onEvent);

  return {
    stop: (): ScrapeObservation => {
      unsubscribe("xrio:stage", onStage);
      unsubscribe("xrio:event", onEvent);

      return { browserArgv, browserPids, stagesMs };
    },
  };
};

export type ScrapeWatch = ReturnType<typeof watchScrape>;
