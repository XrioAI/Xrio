import { XrioError } from "../errors.ts";
import { eachInOrder } from "../lifecycle/sequence.ts";
import { startInOrder, stopInReverse } from "../lifecycle/start-stop.ts";
import type { Startable } from "../lifecycle/start-stop.ts";
import type { Logger } from "../logging/logger.ts";
import type { Page, Route, ScrapeRequest, ScrapeResult } from "../scrape/types.ts";
import { stepsOf } from "./plugin.ts";
import type { PipelineStep, Plugin } from "./plugin.ts";

const NO_ROUTE: Route = {};

/**
 * Runs the registered plugins at each step of a scrape. It owns the step semantics:
 * some steps chain (each plugin sees the previous one's output), some are first-answer-wins,
 * some are side effects. Plugin failures are labelled with the plugin and the step.
 */
export class Pipeline {
  readonly #plugins: Plugin[] = [];
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  add(plugin: Plugin): void {
    this.#plugins.push(plugin);
  }

  has(name: string): boolean {
    return this.#plugins.some((plugin) => plugin.name === name);
  }

  describe(): { name: string; steps: PipelineStep[] }[] {
    return this.#plugins.map((plugin) => ({ name: plugin.name, steps: stepsOf(plugin) }));
  }

  async start(): Promise<void> {
    await startInOrder(this.#lifecycle());
  }

  async stop(): Promise<void> {
    await stopInReverse(this.#lifecycle());
  }

  async beforeScrape(request: ScrapeRequest): Promise<ScrapeRequest> {
    let current = request;
    const logger = this.#logger;

    await eachInOrder(this.#plugins, async (plugin) => {
      const hook = plugin.hooks.beforeScrape;

      if (hook) {
        const replaced = await this.#run(
          plugin,
          "beforeScrape",
          async () => await hook({ logger, request: current }),
        );

        current = replaced ?? current;
      }
    });

    return current;
  }

  async resolveRoute(request: ScrapeRequest): Promise<Route> {
    let route: Route | undefined;
    const logger = this.#logger;

    await eachInOrder(this.#plugins, async (plugin) => {
      const hook = plugin.hooks.resolveRoute;

      if (hook && route === undefined) {
        route = await this.#run(
          plugin,
          "resolveRoute",
          async () => await hook({ logger, request }),
        );
      }
    });

    return route ?? NO_ROUTE;
  }

  async afterFetch(request: ScrapeRequest, page: Page): Promise<Page> {
    let current = page;
    const logger = this.#logger;

    await eachInOrder(this.#plugins, async (plugin) => {
      const hook = plugin.hooks.afterFetch;

      if (hook) {
        const replaced = await this.#run(
          plugin,
          "afterFetch",
          async () => await hook({ logger, page: current, request }),
        );

        current = replaced ?? current;
      }
    });

    return current;
  }

  async afterScrape(request: ScrapeRequest, result: ScrapeResult): Promise<void> {
    const logger = this.#logger;

    await eachInOrder(this.#plugins, async (plugin) => {
      const hook = plugin.hooks.afterScrape;

      if (hook) {
        await this.#run(plugin, "afterScrape", async () => {
          await hook({ logger, request, result });
        });
      }
    });
  }

  async onError(request: ScrapeRequest, error: Error): Promise<void> {
    const logger = this.#logger;

    await eachInOrder(this.#plugins, async (plugin) => {
      try {
        await plugin.hooks.onError?.({ error, logger, request });
      } catch (hookError) {
        // Error reporting must never mask the failure it is reporting.
        logger.warn("plugin onError hook failed", { plugin: plugin.name });
        logger.debug("plugin onError hook failure detail", {
          message: hookError instanceof Error ? hookError.message : String(hookError),
        });
      }
    });
  }

  #lifecycle(): Startable[] {
    const logger = this.#logger;

    return this.#plugins.map((plugin) => ({
      start: async () =>
        await this.#run(plugin, "start", async () => await plugin.hooks.start?.({ logger })),
      stop: async () =>
        await this.#run(plugin, "stop", async () => await plugin.hooks.stop?.({ logger })),
    }));
  }

  /** Labels a plugin failure with the plugin and step, keeping the original as `cause`. */
  async #run<T>(plugin: Plugin, step: PipelineStep, hook: () => Promise<T> | T): Promise<T> {
    this.#logger.debug("plugin step", { plugin: plugin.name, step });

    try {
      return await hook();
    } catch (error) {
      throw new XrioError("plugin_failed", `Plugin "${plugin.name}" failed during ${step}.`, {
        cause: error,
      });
    }
  }
}
