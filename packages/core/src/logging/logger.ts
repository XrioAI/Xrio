export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, boolean | number | string>>;

export interface Logger {
  readonly debug: (message: string, fields?: LogFields) => void;
  readonly info: (message: string, fields?: LogFields) => void;
  readonly warn: (message: string, fields?: LogFields) => void;
  readonly error: (message: string, fields?: LogFields) => void;
}

/** Receives one finished, formatted log line (no trailing newline). */
export type LogSink = (line: string, level: LogLevel) => void;

export interface LoggerSettings {
  readonly enabled: boolean;
  readonly level: LogLevel;
  readonly sink: LogSink;
}

const LEVEL_LABEL_WIDTH = 5;

/** Warnings and errors go to stderr so they survive stdout being piped elsewhere. */
export const stdioSink: LogSink = (line, level) => {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

const formatFields = (fields: LogFields | undefined): string =>
  Object.entries(fields ?? {})
    .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
    .join("");

const formatLine = (level: LogLevel, message: string, fields: LogFields | undefined): string =>
  `${new Date().toISOString()} ${level.toUpperCase().padEnd(LEVEL_LABEL_WIDTH)} ${message}${formatFields(fields)}`;

/** Drops everything below `level`, or everything at all when logging is disabled. */
export const createLogger = ({ enabled, level, sink }: LoggerSettings): Logger => {
  const threshold = LOG_LEVELS.indexOf(level);

  const writerFor =
    (messageLevel: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      if (enabled && LOG_LEVELS.indexOf(messageLevel) >= threshold) {
        sink(formatLine(messageLevel, message, fields), messageLevel);
      }
    };

  return {
    debug: writerFor("debug"),
    error: writerFor("error"),
    info: writerFor("info"),
    warn: writerFor("warn"),
  };
};
