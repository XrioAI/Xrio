import type { SourceDocument } from "./types.ts";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections cross the runtime boundary as unknown values.
export const scrapeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error("The scrape failed.", { cause: error });

export type ScrapeOutcome =
  | { readonly kind: "document"; readonly document: SourceDocument }
  | { readonly kind: "failed"; readonly error: Error };

export const outcomeOf = async (document: Promise<SourceDocument>): Promise<ScrapeOutcome> => {
  try {
    return { document: await document, kind: "document" };
  } catch (error) {
    return { error: scrapeError(error), kind: "failed" };
  }
};
