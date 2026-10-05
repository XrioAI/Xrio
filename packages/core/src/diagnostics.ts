import { channel } from "node:diagnostics_channel";

export type Stage =
  | "queue"
  | "identity"
  | "launch"
  | "verify"
  | "navigation"
  | "challenge"
  | "capture"
  | "teardown";

interface StageTiming {
  stage: Stage;
  durationMs: number;
}

export interface InternalEvent {
  event:
    | "identity-chosen"
    | "fork-probed"
    | "font-stack-checked"
    | "font-settlement-failed"
    | "browser-launched"
    | "cdp-message-dropped"
    | "document-rebind"
    | "raw-header-fallback"
    | "request-log-dropped"
    | "sweep-incomplete"
    | "teardown-incomplete";
  detail: string;
}

const timings = channel("xrio:stage");

const events = channel("xrio:event");

export const publishInternalEvent = (event: InternalEvent): void => {
  if (events.hasSubscribers) {
    events.publish(event);
  }
};

export const timeStage = async <Result>(
  stage: Stage,
  run: () => Promise<Result>,
): Promise<Result> => {
  const started = performance.now();

  try {
    return await run();
  } finally {
    if (timings.hasSubscribers) {
      timings.publish({ durationMs: performance.now() - started, stage } satisfies StageTiming);
    }
  }
};
