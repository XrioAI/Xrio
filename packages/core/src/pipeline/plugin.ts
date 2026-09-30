import type { Logger } from "../logging/logger.ts";
import type { Engine, Page, Route, ScrapeRequest, ScrapeResult } from "../scrape/types.ts";

type Awaitable<T> = Promise<T> | T;

/** Passed to every hook so plugins log through Xrio's configured logger. */
export interface StepContext {
  readonly logger: Logger;
}

/**
 * Every point in a scrape where a plugin may interfere. A plugin declares the steps it
 * touches by providing a hook under that step's name; steps it omits are never called.
 */
export interface PluginHooks {
  /** Xrio.start(): open connections, create directories, warm caches. */
  start?: (context: StepContext) => Awaitable<void>;
  /** Xrio.stop(): release whatever `start` acquired. */
  stop?: (context: StepContext) => Awaitable<void>;
  /** Before anything runs. Return a request to replace it (auth, defaults, rewriting). */
  beforeScrape?: (
    context: StepContext & { request: ScrapeRequest },
  ) => Awaitable<ScrapeRequest | undefined>;
  /** Choose how the target is reached (proxies, geo-targeting). First plugin to answer wins. */
  resolveRoute?: (
    context: StepContext & { request: ScrapeRequest },
  ) => Awaitable<Route | undefined>;
  /** After the engine fetched the page, before formatting. Return a page to replace it. */
  afterFetch?: (
    context: StepContext & { request: ScrapeRequest; page: Page },
  ) => Awaitable<Page | undefined>;
  /** After the result is final: persist it (files, databases, queues). */
  afterScrape?: (
    context: StepContext & { request: ScrapeRequest; result: ScrapeResult },
  ) => Awaitable<void>;
  /** Any failure of a scrape. Errors thrown from this hook are ignored. */
  onError?: (context: StepContext & { request: ScrapeRequest; error: Error }) => Awaitable<void>;
}

export type PipelineStep = keyof PluginHooks;

export const PIPELINE_STEPS = [
  "start",
  "stop",
  "beforeScrape",
  "resolveRoute",
  "afterFetch",
  "afterScrape",
  "onError",
] as const satisfies readonly PipelineStep[];

export interface Plugin {
  readonly name: string;
  /** Engines this plugin contributes, e.g. a browser plugin providing "headless". */
  readonly engines?: readonly Engine[];
  readonly hooks: PluginHooks;
}

export const definePlugin = (plugin: Plugin): Plugin => plugin;

export const stepsOf = (plugin: Plugin): PipelineStep[] =>
  PIPELINE_STEPS.filter((step) => plugin.hooks[step] !== undefined);
