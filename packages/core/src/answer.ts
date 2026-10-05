import type { ScrapeOutcome } from "./outcome.ts";
import type { SourceDocument } from "./types.ts";

export interface Answer {
  readonly promise: Promise<SourceDocument>;
  readonly offer: (outcome: ScrapeOutcome, final: boolean) => void;
  readonly fail: (error: Error) => void;
  readonly settleWithFallback: () => void;
}

type AnswerState =
  | { readonly kind: "pending"; readonly fallback: SourceDocument | undefined }
  | { readonly kind: "settled" };

export const createAnswer = (): Answer => {
  const answer = Promise.withResolvers<SourceDocument>();
  let state: AnswerState = { fallback: undefined, kind: "pending" };

  const serve = (document: SourceDocument) => {
    state = { kind: "settled" };
    answer.resolve(document);
  };

  const fail = (error: Error) => {
    if (state.kind === "settled") {
      return;
    }

    if (state.fallback !== undefined) {
      serve(state.fallback);

      return;
    }

    state = { kind: "settled" };
    answer.reject(error);
  };

  const offer: Answer["offer"] = (outcome, final) => {
    if (state.kind === "settled") {
      return;
    }

    if (outcome.kind === "failed") {
      fail(outcome.error);

      return;
    }

    if (final) {
      serve(outcome.document);
    } else {
      state = { fallback: outcome.document, kind: "pending" };
    }
  };

  const settleWithFallback = () => {
    if (state.kind === "pending") {
      fail(new Error("The scrape ended without a document."));
    }
  };

  void Promise.allSettled([answer.promise]);

  return { fail, offer, promise: answer.promise, settleWithFallback };
};
