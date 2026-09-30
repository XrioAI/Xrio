import { startApiServer } from "./api/server.ts";
import type { ApiServer } from "./api/server.ts";
import { resolveOptions } from "./config.ts";
import type { ResolvedOptions, XrioOptions } from "./config.ts";
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
  readonly #options: ResolvedOptions;
  readonly #logger: Logger;
  readonly #pipeline: Pipeline;
  readonly #engines = new EngineRegistry();
  #http: ApiServer | undefined;
  #started = false;

  private constructor(options: XrioOptions) {
    this.#options = resolveOptions(options);
    this.#logger = createLogger(this.#options.log);
    this.#pipeline = new Pipeline(this.#logger);
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

  /** Where the HTTP server listens, once started with `http.enabled`. */
  get httpUrl(): string | undefined {
    return this.#http?.url;
  }

  /** Where the Swagger UI is served, when both the HTTP server and `http.docs` are on. */
  get docsUrl(): string | undefined {
    return this.#http && this.#options.http.docs ? `${this.#http.url}/docs` : undefined;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new XrioError("already_started", "Xrio is already started.");
    }

    await startInOrder(this.#components());
    this.#started = true;
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

  /** Started in this order and stopped in the reverse: engines, plugins, then the HTTP server. */
  #components(): Startable[] {
    return [this.#engines, this.#pipeline, this.#httpComponent()];
  }

  #httpComponent(): Startable {
    const { docs, enabled, host, port } = this.#options.http;

    return {
      start: async () => {
        if (!enabled) {
          return;
        }

        this.#http = await startApiServer({
          docs,
          host,
          logger: this.#logger,
          port,
          scrape: async (body) => await this.#scrapeUntrusted(body),
        });
        this.#logger.info("http server listening", {
          docs: docs ? `${this.#http.url}/docs` : "off",
          url: this.#http.url,
        });
      },
      stop: async () => {
        await this.#http?.close();
        this.#http = undefined;
      },
    };
  }
}
