import type { Deadline } from "./deadline.ts";
import { clientClosed, isXrioError, XrioError } from "./errors.ts";
import type { SourceDocument } from "./types.ts";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections cross the runtime boundary as unknown values.
export const scrapeError = (error: unknown, deadline: Deadline): Error => {
  if (isXrioError(error)) {
    return error;
  }

  if (deadline.signal.aborted) {
    const abortedBy = deadline.abortReason();

    switch (abortedBy) {
      case "expired": {
        return deadline.signal.reason instanceof Error
          ? deadline.signal.reason
          : new XrioError("TIMEOUT", "The scrape deadline expired.", { details: undefined });
      }

      case "ownership": {
        return new XrioError("SESSION_UNAVAILABLE", "The scrape lost session ownership.", {
          cause: deadline.signal.reason,
          details: { reason: "ownership-lost" },
        });
      }

      case "client-closed": {
        return clientClosed();
      }

      case "caller":
      case undefined: {
        const reason: unknown = deadline.signal.reason;

        return reason instanceof Error
          ? reason
          : Object.assign(new Error("The scrape was aborted.", { cause: reason }), {
              name: "AbortError",
            });
      }

      default: {
        const exhaustive: never = abortedBy;

        return exhaustive;
      }
    }
  }

  return error instanceof Error ? error : new Error("The scrape failed.", { cause: error });
};

export type ScrapeOutcome =
  | { readonly kind: "document"; readonly document: SourceDocument }
  | { readonly kind: "failed"; readonly error: Error };

export const outcomeOf = async (
  document: Promise<SourceDocument>,
  deadline: Deadline,
): Promise<ScrapeOutcome> => {
  try {
    return { document: await document, kind: "document" };
  } catch (error) {
    return { error: scrapeError(error, deadline), kind: "failed" };
  }
};
