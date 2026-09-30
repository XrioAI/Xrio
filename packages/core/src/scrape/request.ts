/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- this file is the parsing boundary for untrusted scrape requests */
import { XrioError } from "../errors.ts";
import { OUTPUT_FORMATS, SCRAPE_MODES } from "./types.ts";
import type { Location, OutputFormat, ScrapeMode, ScrapeRequest } from "./types.ts";

const DEFAULT_MODE: ScrapeMode = "http";

const DEFAULT_FORMAT: OutputFormat = "html";

const WEB_PROTOCOLS = new Set(["http:", "https:"]);

const LOCATION_FIELDS = ["country", "state", "city"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMember = <T extends string>(options: readonly T[], value: unknown): value is T =>
  options.some((option) => option === value);

const invalid = (message: string): XrioError => new XrioError("invalid_request", message);

const parseUrl = (value: unknown): string => {
  if (typeof value !== "string") {
    throw invalid('"url" is required and must be a string.');
  }

  const parsed = URL.parse(value);

  if (!parsed || !WEB_PROTOCOLS.has(parsed.protocol)) {
    throw invalid('"url" must be an absolute http or https URL.');
  }

  return parsed.href;
};

const parseChoice = <T extends string>(
  field: string,
  options: readonly T[],
  value: unknown,
  fallback: T,
): T => {
  if (value === undefined) {
    return fallback;
  }

  if (!isMember(options, value)) {
    throw invalid(`"${field}" must be one of: ${options.join(", ")}.`);
  }

  return value;
};

const parseLocationField = (source: Record<string, unknown>, field: string): string | undefined => {
  const entry = source[field];

  if (entry === undefined) {
    return undefined;
  }

  if (typeof entry !== "string" || entry.trim() === "") {
    throw invalid(`"location.${field}" must be a non-empty string.`);
  }

  return entry.trim();
};

const parseLocation = (value: unknown): Location | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw invalid('"location" must be an object with optional country, state and city.');
  }

  const entries = LOCATION_FIELDS.flatMap((field) => {
    const parsed = parseLocationField(value, field);

    return parsed === undefined ? [] : [[field, parsed] as const];
  });

  return Object.fromEntries(entries);
};

/** Turns untrusted input into a request with defaults applied, or throws `invalid_request`. */
export const parseScrapeInput = (input: unknown): ScrapeRequest => {
  if (!isRecord(input)) {
    throw invalid("A scrape request must be an object.");
  }

  const location = parseLocation(input.location);

  return {
    format: parseChoice("format", OUTPUT_FORMATS, input.format, DEFAULT_FORMAT),
    mode: parseChoice("mode", SCRAPE_MODES, input.mode, DEFAULT_MODE),
    url: parseUrl(input.url),
    ...(location && { location }),
  };
};
