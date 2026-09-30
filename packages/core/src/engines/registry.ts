import { XrioError } from "../errors.ts";
import { startInOrder, stopInReverse } from "../lifecycle/start-stop.ts";
import type { Engine, ScrapeMode } from "../scrape/types.ts";

/** Knows which engine serves which scrape mode, and starts and stops them together. */
export class EngineRegistry {
  readonly #engines = new Map<ScrapeMode, Engine>();

  register(engine: Engine, owner: string): void {
    if (this.#engines.has(engine.mode)) {
      throw new XrioError(
        "plugin_conflict",
        `${owner} provides an engine for "${engine.mode}" mode, but one is already registered.`,
      );
    }

    this.#engines.set(engine.mode, engine);
  }

  engineFor(mode: ScrapeMode): Engine {
    const engine = this.#engines.get(mode);

    if (!engine) {
      throw new XrioError(
        "engine_unavailable",
        `No engine is registered for "${mode}" mode. Add a plugin that provides one.`,
      );
    }

    return engine;
  }

  async start(): Promise<void> {
    await startInOrder([...this.#engines.values()]);
  }

  async stop(): Promise<void> {
    await stopInReverse([...this.#engines.values()]);
  }
}
