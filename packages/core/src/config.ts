/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-object-parameters -- This module is the file boundary where untrusted configuration is parsed into named sections. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { invalidOptions } from "./errors.ts";
import { resolveProxyConfig } from "./proxy/config.ts";
import type { ProxyConfig } from "./proxy/config.ts";

export interface XrioConfig {
  proxy?: ProxyConfig;
}

const SECTIONS = {
  proxy: resolveProxyConfig,
} as const satisfies Record<keyof XrioConfig, (value: unknown) => unknown>;

const isSection = (key: string): key is keyof typeof SECTIONS => Object.hasOwn(SECTIONS, key);

const rejectUnknownSections = (config: object): void => {
  if (!Object.keys(config).every(isSection)) {
    throw invalidOptions(
      `xrio.config supports only these top-level keys: ${Object.keys(SECTIONS).join(", ")}.`,
    );
  }
};

const resolveSections = (config: object): XrioConfig => {
  rejectUnknownSections(config);

  return "proxy" in config && config.proxy !== undefined
    ? { proxy: SECTIONS.proxy(config.proxy) }
    : {};
};

const CONFIG_FILES = ["xrio.config.ts", "xrio.config.mts", "xrio.config.js", "xrio.config.mjs"];

const requireConfig = createRequire(import.meta.url);

const isConfigModule = (value: unknown): value is { default: object } =>
  typeof value === "object" &&
  value !== null &&
  "default" in value &&
  typeof value.default === "object" &&
  value.default !== null &&
  !Array.isArray(value.default) &&
  (Object.getPrototypeOf(value.default) === Object.prototype ||
    Object.getPrototypeOf(value.default) === null);

export const loadXrioConfig = (directory = process.cwd()): XrioConfig => {
  const files = CONFIG_FILES.flatMap((file) => {
    const candidate = path.resolve(directory, file);

    return existsSync(candidate) ? [candidate] : [];
  });

  if (files.length === 0) {
    return {};
  }

  if (files.length > 1) {
    throw invalidOptions(
      "Found multiple xrio.config files; keep exactly one in the working directory.",
    );
  }

  let loaded: unknown;

  try {
    loaded = requireConfig(files[0]);
  } catch {
    // Loader errors can include source lines containing proxy credentials.
    throw invalidOptions(
      "Could not load xrio.config; use a synchronous default-exported object and Node-supported TypeScript syntax.",
    );
  }

  if (!isConfigModule(loaded)) {
    throw invalidOptions("xrio.config must default-export a configuration object.");
  }

  return resolveSections(loaded.default);
};
