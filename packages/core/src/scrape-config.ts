/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This module is the runtime parser for untrusted scrape configuration. */
import { invalidOptions } from "./errors.ts";
import { isPlainObject } from "./host-config.ts";

export interface ScrapeConfig {
  retries?: number;
}

export interface ScrapeSettings {
  readonly retries: number;
}

export const resolveScrapeConfig = (value?: unknown): ScrapeSettings => {
  if (value === undefined) {
    return { retries: 0 };
  }

  if (!isPlainObject(value)) {
    throw invalidOptions("scrape must be an object.");
  }

  if (Object.keys(value).some((key) => key !== "retries")) {
    throw invalidOptions("scrape only supports retries.");
  }

  const retries = "retries" in value && value.retries !== undefined ? value.retries : 0;

  if (typeof retries !== "number" || !Number.isSafeInteger(retries) || retries < 0) {
    throw invalidOptions("scrape.retries must be a nonnegative safe integer.");
  }

  return { retries };
};
