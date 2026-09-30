import { XrioError } from "./errors.ts";
import { LOG_LEVELS, stdioSink } from "./logging/logger.ts";
import type { LogLevel, LogSink } from "./logging/logger.ts";

export interface LogOptions {
  /** Default: true. */
  readonly enabled?: boolean;
  /** Log this level and above. Default: "info". */
  readonly level?: LogLevel;
  /** Where log lines go. Default: stdout, with warnings and errors on stderr. */
  readonly sink?: LogSink;
}

export interface XrioOptions {
  readonly log?: LogOptions;
}

export interface ResolvedOptions {
  readonly log: Required<LogOptions>;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  log: { enabled: true, level: "info", sink: stdioSink },
};

const invalid = (message: string): XrioError => new XrioError("invalid_config", message);

const assertValid = ({ log }: ResolvedOptions): void => {
  if (!LOG_LEVELS.includes(log.level)) {
    throw invalid(`"log.level" must be one of: ${LOG_LEVELS.join(", ")}.`);
  }
};

/** Fills every unset option with its default and rejects values that cannot work. */
export const resolveOptions = ({ log }: XrioOptions = {}): ResolvedOptions => {
  const resolved: ResolvedOptions = {
    log: { ...DEFAULT_OPTIONS.log, ...log },
  };

  assertValid(resolved);

  return resolved;
};
