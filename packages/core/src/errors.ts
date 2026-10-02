import type { BlockReport } from "./blocks/classify.ts";
import type { ResponseDetails } from "./types.ts";

interface XrioErrorDetails {
  BROWSER_CRASHED: undefined;
  BROWSER_LAUNCH_FAILED: { stderr: string };
  CLIENT_CLOSED: undefined;
  MODE_NOT_IMPLEMENTED: undefined;
  NETWORK_ERROR: { netError: string } | undefined;
  PROXY_AUTH_FAILED: undefined;
  PROXY_CONNECT_FAILED: { status: number };
  PROXY_UNREACHABLE: undefined;
  RESPONSE_TOO_LARGE: undefined;
  TIMEOUT: undefined;
  TLS_CERTIFICATE_INVALID: undefined;
  TOO_MANY_REDIRECTS: undefined;
  UNSUPPORTED_CONTENT_TYPE: ResponseDetails & { body: string; block: BlockReport };
}

export type XrioErrorCode = keyof XrioErrorDetails;

export type ErrorCode = XrioErrorCode | "INVALID_OPTIONS";

type XrioErrorArguments<Code extends XrioErrorCode> = Code extends XrioErrorCode
  ? [code: Code, message: string, init: { cause?: unknown; details: XrioErrorDetails[Code] }]
  : never;

export class XrioError<Code extends XrioErrorCode = XrioErrorCode> extends Error {
  override readonly name = "XrioError";
  readonly code: Code;
  readonly details: XrioErrorDetails[Code];

  constructor(...init: XrioErrorArguments<Code>);
  constructor(
    code: Code,
    message: string,
    { cause, details }: { cause?: unknown; details: XrioErrorDetails[Code] },
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.details = details;
  }
}

export type InvalidOptionsError = TypeError & { code: "INVALID_OPTIONS" };

type ErrorByCode = { [Code in XrioErrorCode]: XrioError<Code> } & {
  INVALID_OPTIONS: InvalidOptionsError;
};

const errorClasses = {
  BROWSER_CRASHED: XrioError,
  BROWSER_LAUNCH_FAILED: XrioError,
  CLIENT_CLOSED: XrioError,
  INVALID_OPTIONS: TypeError,
  MODE_NOT_IMPLEMENTED: XrioError,
  NETWORK_ERROR: XrioError,
  PROXY_AUTH_FAILED: XrioError,
  PROXY_CONNECT_FAILED: XrioError,
  PROXY_UNREACHABLE: XrioError,
  RESPONSE_TOO_LARGE: XrioError,
  TIMEOUT: XrioError,
  TLS_CERTIFICATE_INVALID: XrioError,
  TOO_MANY_REDIRECTS: XrioError,
  UNSUPPORTED_CONTENT_TYPE: XrioError,
} satisfies Record<ErrorCode, TypeErrorConstructor | typeof XrioError>;

const isErrorCode = (code: unknown): code is ErrorCode =>
  typeof code === "string" && Object.hasOwn(errorClasses, code);

export function isXrioError(value: unknown): value is ErrorByCode[ErrorCode];
export function isXrioError<Code extends ErrorCode>(
  value: unknown,
  code: Code,
): value is ErrorByCode[Code];
export function isXrioError(value: unknown, code?: ErrorCode): value is ErrorByCode[ErrorCode] {
  return (
    value instanceof Error &&
    "code" in value &&
    isErrorCode(value.code) &&
    value instanceof errorClasses[value.code] &&
    (code === undefined || value.code === code)
  );
}

export const invalidOptions = (message: string, cause?: unknown): InvalidOptionsError =>
  Object.assign(new TypeError(message, cause === undefined ? undefined : { cause }), {
    code: "INVALID_OPTIONS" as const,
  });

export const redactUrl = (url: URL | string): string => {
  const redacted = new URL(url);

  redacted.username = "";
  redacted.password = "";

  return redacted.href;
};

export const clientClosed = (): XrioError =>
  new XrioError("CLIENT_CLOSED", "The client is closed.", { details: undefined });
