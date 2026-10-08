import { invalidOptions } from "../errors.ts";
import type { ScrapeOptions } from "../types.ts";
import { OWNED_HEADERS } from "./owned-inputs.ts";

export interface RequestHeaders {
  readonly [name: string]: string;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u;

const HEADER_VALUE = /^[\t\u0020-\u007E\u0080-\u00FF]*$/u;

const HEADER_OWNERS = new Map<string, string>([
  ...OWNED_HEADERS.map((name) => [name, "the identity profile"] as const),
  ["cookie", "the cookies option"],
]);

export const parseRequestHeaders = (value: ScrapeOptions["headers"]): RequestHeaders => {
  if (value === undefined) {
    return {};
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public JavaScript options are untrusted.
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidOptions("headers must be an object of header names and string values.");
  }

  const headers: [string, string][] = [];

  for (const [name, content] of Object.entries(value)) {
    const normalized = name.toLowerCase();
    const owner = HEADER_OWNERS.get(normalized);

    if (owner !== undefined) {
      throw invalidOptions(`${normalized} is owned by ${owner}.`);
    }

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Validate header values at the public boundary.
    if (!HEADER_NAME.test(name) || typeof content !== "string" || !HEADER_VALUE.test(content)) {
      throw invalidOptions("headers contains an invalid header name or value.");
    }

    headers.push([normalized, content.trim()]);
  }

  return Object.fromEntries(headers);
};

export const requestHeaderOrder = (
  profile: readonly string[],
  headers: RequestHeaders,
): string[] => {
  const owned = new Set(profile.map((name) => name.toLowerCase()));

  return [...profile, ...Object.keys(headers).filter((name) => !owned.has(name.toLowerCase()))];
};
