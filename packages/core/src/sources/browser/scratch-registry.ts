import type { Deadline } from "../../deadline.ts";
import { outsideScrapeContext, publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { createScratchDir, scratchRoot, sweepAbandonedScratch } from "./browser-process.ts";
import type { ScratchDir } from "./browser-process.ts";
import { withinSignal } from "./lifetime.ts";
import { TEARDOWN_BUDGET_MS } from "./port.ts";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class ScratchRegistry {
  readonly #root: string;
  #swept: Promise<void> | undefined;

  constructor(root = scratchRoot()) {
    this.#root = root;
  }

  // oxlint-disable-next-line typescript/promise-function-async -- callers share the exact same in-flight promise.
  sweep(): Promise<void> {
    this.#swept ??= outsideScrapeContext(async () => {
      await this.#sweep();
    });

    return this.#swept;
  }

  async create(deadline: Deadline): Promise<ScratchDir> {
    deadline.throwIfExpired();

    await withinSignal(async () => {
      await this.sweep();
    }, deadline.signal);

    return await createScratchDir(Date.now(), this.#root);
  }

  async settle(): Promise<void> {
    await this.#swept;
  }

  async #sweep(): Promise<void> {
    const signal = AbortSignal.timeout(TEARDOWN_BUDGET_MS);

    try {
      await timeStage("scratch-sweep", async () => {
        await withinSignal(async () => await sweepAbandonedScratch(this.#root, Date.now()), signal);
      });
    } catch (error) {
      publishInternalEvent({
        detail: `The scratch sweep failed: ${messageOf(error)}`,
        event: "sweep-incomplete",
      });
    }
  }
}
