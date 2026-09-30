import { resolveOptions } from "./config.ts";
import type { XrioOptions } from "./config.ts";
import { createHttpEngine } from "./engines/http.ts";
import { EngineRegistry } from "./engines/registry.ts";
import { XrioError, toError } from "./errors.ts";
import { startInOrder, stopInReverse } from "./lifecycle/start-stop.ts";
import type { Startable } from "./lifecycle/start-stop.ts";
import { createLogger } from "./logging/logger.ts";
import type { Logger } from "./logging/logger.ts";
import { Pipeline } from "./pipeline/pipeline.ts";
import type { PipelineStep, Plugin } from "./pipeline/plugin.ts";
import { assertFormatSupported, buildResult } from "./scrape/formats.ts";
import { parseScrapeInput } from "./scrape/request.ts";
import type { ScrapeInput, ScrapeRequest, ScrapeResult } from "./scrape/types.ts";

/**
 * The scraper. Create one, add plugins with `use`, `start` it, call `scrape` as often as you
 * like (concurrently is fine), then `stop` it.
 */
export class Xrio {
  readonly #logger: Logger;
  readonly #pipeline: Pipeline;
  readonly #engines = new EngineRegistry();
  #started = false;

  private constructor(options: XrioOptions) {
    this.#logger = createLogger(resolveOptions(options).log);
    this.#pipeline = new Pipeline({
      logger: this.#logger,
      scrape: async (input) => await this.scrape(input),
    });
    this.#engines.register(createHttpEngine(), "Xrio");
  }

  static create(options: XrioOptions = {}): Xrio {
    return new Xrio(options);
  }

  /** Registers a plugin. Only possible before `start`. */
  use(plugin: Plugin): this {
    if (this.#started) {
      throw new XrioError("already_started", "Plugins must be added before Xrio starts.");
    }

    if (this.#pipeline.has(plugin.name)) {
      throw new XrioError(
        "plugin_conflict",
        `A plugin named "${plugin.name}" is already registered.`,
      );
    }

    for (const engine of plugin.engines ?? []) {
      this.#engines.register(engine, `Plugin "${plugin.name}"`);
    }

    this.#pipeline.add(plugin);
    this.#logger.debug("plugin registered", { plugin: plugin.name });

    return this;
  }

  /** The registered plugins and the pipeline steps each one interferes with. */
  get plugins(): { name: string; steps: PipelineStep[] }[] {
    return this.#pipeline.describe();
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new XrioError("already_started", "Xrio is already started.");
    }

    // Marked started up front so plugins (like an HTTP API) can accept scrapes as soon as
    // their own start hook finishes; rolled back if anything fails to start.
    this.#started = true;

    try {
      await startInOrder(this.#components());
    } catch (error) {
      this.#started = false;
      throw error;
    }

    this.#logger.info("xrio started", { plugins: this.#pipeline.describe().length });
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      return;
    }

    this.#started = false;
    await stopInReverse(this.#components());
    this.#logger.info("xrio stopped");
  }

  async scrape(input: ScrapeInput): Promise<ScrapeResult> {
    return await this.#scrapeUntrusted(input);
  }

  /** The typed `scrape` and the HTTP API share this path; input is validated either way. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the HTTP API passes untrusted JSON here
  async #scrapeUntrusted(input: unknown): Promise<ScrapeResult> {
    if (!this.#started) {
      throw new XrioError("not_started", "Call start() before scrape().");
    }

    const request = parseScrapeInput(input);
    assertFormatSupported(request.format);
    const startedAt = performance.now();
    this.#logger.info("scrape started", {
      format: request.format,
      mode: request.mode,
      url: request.url,
    });

    try {
      const result = await this.#runPipeline(request);
      this.#logger.info("scrape finished", {
        ms: Math.round(performance.now() - startedAt),
        status: result.status,
        url: request.url,
      });

      return result;
    } catch (error) {
      const failure = toError(error);
      this.#logger.warn("scrape failed", {
        code: failure instanceof XrioError ? failure.code : "unknown",
        message: failure.message,
        url: request.url,
      });
      await this.#pipeline.onError(request, failure);
      throw error;
    }
  }

  async #runPipeline(initial: ScrapeRequest): Promise<ScrapeResult> {
    const request = await this.#pipeline.beforeScrape(initial);
    const route = await this.#pipeline.resolveRoute(request);
    const fetched = await this.#engines.engineFor(request.mode).fetch(request, route);
    const page = await this.#pipeline.afterFetch(request, fetched);
    const result = buildResult(request, page);
    await this.#pipeline.afterScrape(request, result);

    return result;
  }

  /** Started in this order and stopped in the reverse: engines, then plugins. */
  #components(): Startable[] {
    return [this.#engines, this.#pipeline];
  }
}
