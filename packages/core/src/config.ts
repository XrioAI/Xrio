import { XrioError } from "./errors.ts";
import { LOG_LEVELS, stdioSink } from "./logging/logger.ts";
import type { LogLevel, LogSink } from "./logging/logger.ts";

const MAX_PORT = 65_535;

export interface HttpOptions {
  /** Serve `POST /scrape` over HTTP. Default: false. */
  readonly enabled?: boolean;
  /** Default: 3000. Use 0 to let the OS pick a free port. */
  readonly port?: number;
  /** Default: 127.0.0.1, so the API is not exposed to the network by accident. */
  readonly host?: string;
  /** Serve the Swagger UI at `/docs` and the OpenAPI document at `/docs.json`. Default: true. */
  readonly docs?: boolean;
}

export interface LogOptions {
  /** Default: true. */
  readonly enabled?: boolean;
  /** Log this level and above. Default: "info". */
  readonly level?: LogLevel;
  /** Where log lines go. Default: stdout, with warnings and errors on stderr. */
  readonly sink?: LogSink;
}

export interface XrioOptions {
  readonly http?: HttpOptions;
  readonly log?: LogOptions;
}

export interface ResolvedOptions {
  readonly http: Required<HttpOptions>;
  readonly log: Required<LogOptions>;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  http: { docs: true, enabled: false, host: "127.0.0.1", port: 3000 },
  log: { enabled: true, level: "info", sink: stdioSink },
};

const invalid = (message: string): XrioError => new XrioError("invalid_config", message);

const assertValid = ({ http, log }: ResolvedOptions): void => {
  if (!Number.isInteger(http.port) || http.port < 0 || http.port > MAX_PORT) {
    throw invalid(`"http.port" must be an integer from 0 to ${MAX_PORT}.`);
  }

  if (!LOG_LEVELS.includes(log.level)) {
    throw invalid(`"log.level" must be one of: ${LOG_LEVELS.join(", ")}.`);
  }
};

/** Fills every unset option with its default and rejects values that cannot work. */
export const resolveOptions = ({ http, log }: XrioOptions = {}): ResolvedOptions => {
  const resolved: ResolvedOptions = {
    http: { ...DEFAULT_OPTIONS.http, ...http },
    log: { ...DEFAULT_OPTIONS.log, ...log },
  };

  assertValid(resolved);

  return resolved;
};
