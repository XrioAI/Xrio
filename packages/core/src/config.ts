import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { invalidOptions } from "./errors.ts";
import { resolveProxyConfig } from "./proxy/config.ts";
import type { ProxyConfig } from "./proxy/config.ts";

export interface XrioConfig {
  proxy?: ProxyConfig;
  /** Other managers validate their own configuration sections. */
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Preserve other managers' sections at the file boundary; their owners validate them.
  [section: string]: unknown;
}

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

  const config = loaded.default;

  return "proxy" in config && config.proxy !== undefined
    ? { ...config, proxy: resolveProxyConfig(config.proxy) }
    : { ...config };
};
