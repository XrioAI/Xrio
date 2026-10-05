import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

export type Stage =
  | "scratch-sweep"
  | "queue"
  | "identity"
  | "launch"
  | "verify"
  | "navigation"
  | "challenge"
  | "capture"
  | "teardown";

interface StageTiming {
  readonly scrapeId: string | undefined;
  readonly outcome: "ok" | "failed" | "aborted";
  stage: Stage;
  durationMs: number;
}

export interface InternalEvent {
  event:
    | "identity-chosen"
    | "fork-probed"
    | "font-stack-checked"
    | "font-settlement-failed"
    | "browser-argv"
    | "browser-launched"
    | "cdp-message-dropped"
    | "document-rebind"
    | "raw-header-fallback"
    | "request-log-dropped"
    | "sweep-incomplete"
    | "teardown-incomplete";
  detail: string;
}

interface ScrapeContext {
  readonly scrapeId: string;
}

const context = new AsyncLocalStorage<ScrapeContext>();

export const inScrapeContext = <Result>(scrapeId: string, run: () => Result): Result =>
  context.run({ scrapeId }, run);

export const outsideScrapeContext = <Result>(run: () => Result): Result => context.exit(run);

const timings = channel("xrio:stage");

const events = channel("xrio:event");

export const publishInternalEvent = (event: InternalEvent): void => {
  if (events.hasSubscribers) {
    const scrapeId = context.getStore()?.scrapeId;

    events.publish(scrapeId === undefined ? event : { ...event, scrapeId });
  }
};

export const timeStage = async <Result>(
  stage: Stage,
  run: () => Promise<Result>,
  lifetime?: { readonly signal: AbortSignal },
): Promise<Result> => {
  const started = performance.now();
  let outcome: StageTiming["outcome"] = "ok";

  try {
    return await run();
  } catch (error) {
    outcome = lifetime?.signal.aborted === true ? "aborted" : "failed";

    throw error;
  } finally {
    if (timings.hasSubscribers) {
      timings.publish({
        durationMs: performance.now() - started,
        outcome,
        scrapeId: context.getStore()?.scrapeId,
        stage,
      } satisfies StageTiming);
    }
  }
};
