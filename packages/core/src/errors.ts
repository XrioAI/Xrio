export type XrioErrorCode =
  | "invalid_request"
  | "not_started"
  | "already_started"
  | "engine_unavailable"
  | "format_unsupported"
  | "fetch_failed"
  | "plugin_failed"
  | "plugin_conflict"
  | "invalid_config";

export class XrioError extends Error {
  readonly code: XrioErrorCode;

  constructor(code: XrioErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "XrioError";
    this.code = code;
  }
}

/** Caught values can be anything; this is the single place they become an `Error`. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch clause hands us `unknown`
export const toError = (caught: unknown): Error =>
  caught instanceof Error ? caught : new Error(String(caught), { cause: caught });
