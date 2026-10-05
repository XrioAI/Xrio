import type { Deadline } from "../../deadline.ts";
import { publishInternalEvent, timeStage } from "../../diagnostics.ts";
import { removeScratchDir } from "./browser-process.ts";
import type { ScratchDir } from "./browser-process.ts";
import { killProcessGroup, retireProcessGroup } from "./group-lifetime.ts";
import type { LaunchPlan } from "./launch-plan.ts";
import { settleWithin, withinSignal } from "./lifetime.ts";
import { CLEANUP_BUDGET_MS, CLOSE_BUDGET_MS, DriverError, TEARDOWN_BUDGET_MS } from "./port.ts";
import type { BrowserDriver, DriverBrowser } from "./port.ts";

export type Closed =
  | { readonly exited: true }
  | { readonly exited: false; readonly reason: string };

type Stopped = "exited" | "outlived" | "unknown";

type Ownership =
  | { readonly kind: "not-started" }
  | { readonly kind: "unknown" }
  | { readonly kind: "group"; readonly pid: number };

export interface RetireSteps {
  readonly retireProcessGroup: typeof retireProcessGroup;
  readonly removeScratchDir: typeof removeScratchDir;
}

const defaultSteps: RetireSteps = { removeScratchDir, retireProcessGroup };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const incomplete = (reason: string): Closed => {
  publishInternalEvent({ detail: reason, event: "teardown-incomplete" });

  return { exited: false, reason };
};

export class ChromeScope {
  readonly scratch: ScratchDir;
  readonly #steps: RetireSteps;
  readonly #cleanups: Promise<void>[] = [];
  #ownership: Ownership = { kind: "not-started" };
  #browser: DriverBrowser | undefined;
  #retiring: Promise<Closed> | undefined;

  constructor(scratch: ScratchDir, steps: Partial<RetireSteps> = {}) {
    this.scratch = scratch;
    this.#steps = { ...defaultSteps, ...steps };
  }

  async launch(
    driver: BrowserDriver,
    plan: LaunchPlan,
    deadline: Deadline,
  ): Promise<DriverBrowser> {
    const browser = await driver.launch(
      plan,
      deadline,
      (pid) => {
        this.#own(pid);
      },
      (cleanup) => {
        this.#cleanups.push(cleanup);
        void Promise.allSettled([cleanup]);
      },
    );

    this.#browser = browser;

    if (this.#ownership.kind === "not-started") {
      this.#ownership = { kind: "unknown" };

      throw new DriverError({
        kind: "launch-failed",
        problem: "The driver resolved without reporting process ownership.",
      });
    }

    return browser;
  }

  // oxlint-disable-next-line typescript/promise-function-async -- callers share the exact same in-flight promise.
  retire(): Promise<Closed> {
    this.#retiring ??= timeStage("teardown", async () => await this.#retire());

    return this.#retiring;
  }

  #own(pid: number): void {
    if (this.#ownership.kind !== "not-started") {
      throw new DriverError({
        kind: "launch-failed",
        problem: "The driver reported process ownership more than once.",
      });
    }

    this.#ownership = { kind: "group", pid };
    publishInternalEvent({ detail: String(pid), event: "browser-launched" });
  }

  async #retire(): Promise<Closed> {
    const signal = AbortSignal.timeout(TEARDOWN_BUDGET_MS);
    let stopped: Stopped | undefined;

    try {
      stopped = await withinSignal(async () => await this.#stop(signal), signal);

      if (stopped === "outlived") {
        return incomplete(
          `Chrome outlived its teardown; ${this.scratch.path} is left for the sweep.`,
        );
      }

      if (stopped === "unknown") {
        return incomplete(
          `Chrome's process group is unknown; ${this.scratch.path} is left for the sweep.`,
        );
      }

      await withinSignal(async () => {
        await this.#steps.removeScratchDir(this.scratch, signal);
      }, signal);

      return { exited: true };
    } catch (error) {
      if (stopped !== "exited" && this.#ownership.kind === "group") {
        killProcessGroup(this.#ownership.pid);
      }

      return incomplete(`Teardown of ${this.scratch.path} failed: ${messageOf(error)}`);
    }
  }

  async #stop(signal: AbortSignal): Promise<Stopped> {
    await withinSignal(async () => {
      await settleWithin(Promise.allSettled(this.#cleanups), CLEANUP_BUDGET_MS);
    }, signal);

    const browser = this.#browser;

    if (browser !== undefined) {
      await withinSignal(async () => {
        await settleWithin(browser.close(CLOSE_BUDGET_MS), CLOSE_BUDGET_MS);
      }, signal);
    }

    const ownership = this.#ownership;

    if (ownership.kind !== "group") {
      return ownership.kind === "unknown" ? "unknown" : "exited";
    }

    const retired = await withinSignal(
      async () => await this.#steps.retireProcessGroup(ownership.pid, signal),
      signal,
    );

    return retired ? "exited" : "outlived";
  }
}
