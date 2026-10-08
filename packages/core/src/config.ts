/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-object-parameters -- This module is the file boundary where untrusted configuration is parsed into named sections. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { invalidOptions } from "./errors.ts";
import { resolveHostConfig } from "./host-config.ts";
import type { HostConfig, HostSettings } from "./host-config.ts";
import { resolveProxyConfig } from "./proxy/config.ts";
import type { ProxyConfig } from "./proxy/config.ts";

export interface XrioConfig {
  proxy?: ProxyConfig;
  host?: HostConfig;
}

export interface ResolvedConfig {
  readonly proxy: ProxyConfig | undefined;
  readonly host: HostSettings;
}

const SECTIONS = {
  host: resolveHostConfig,
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

const EMPTY_CONFIG: ResolvedConfig = { host: resolveHostConfig(), proxy: undefined };

const resolveSections = (config: object): ResolvedConfig => {
  rejectUnknownSections(config);

  return {
    host: SECTIONS.host("host" in config ? config.host : undefined),
    proxy:
      "proxy" in config && config.proxy !== undefined ? SECTIONS.proxy(config.proxy) : undefined,
  };
};

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

const readModuleConfig = (file: string): object => {
  let loaded: unknown;

  try {
    loaded = requireConfig(file);
  } catch {
    // Loader errors can include source lines containing proxy credentials.
    throw invalidOptions(
      `Could not load ${file}; use a synchronous default-exported object and Node-supported TypeScript syntax.`,
    );
  }

  if (!isConfigModule(loaded)) {
    throw invalidOptions(`${file} must default-export a configuration object.`);
  }

  return loaded.default;
};

const FORMATS = {
  ".js": readModuleConfig,
  ".mjs": readModuleConfig,
  ".mts": readModuleConfig,
  ".ts": readModuleConfig,
} as const satisfies Record<string, (file: string) => object>;

type ConfigExtension = keyof typeof FORMATS;

interface ConfigFile {
  readonly path: string;
  readonly read: (file: string) => object;
}

const isConfigExtension = (extension: string): extension is ConfigExtension =>
  Object.hasOwn(FORMATS, extension);

const workingDirectoryConfigFile = (cwd: string): ConfigFile | undefined => {
  const files = Object.entries(FORMATS).flatMap(([extension, read]) => {
    const candidate = path.resolve(cwd, `xrio.config${extension}`);

    return existsSync(candidate) ? [{ path: candidate, read }] : [];
  });

  if (files.length > 1) {
    throw invalidOptions(
      "Found multiple xrio.config files; keep exactly one in the working directory.",
    );
  }

  return files[0];
};

const namedConfigFile = (configFile: string, cwd: string): ConfigFile => {
  if (typeof configFile !== "string") {
    throw invalidOptions("configFile must be a path to a config file.");
  }

  const file = path.resolve(cwd, configFile);
  const extension = path.extname(file);

  if (!isConfigExtension(extension)) {
    throw invalidOptions(`configFile must end in ${Object.keys(FORMATS).join(", ")}: ${file}`);
  }

  if (!existsSync(file)) {
    throw invalidOptions(`configFile does not exist: ${file}`);
  }

  return { path: file, read: FORMATS[extension] };
};

const locateConfigFile = (configFile: string | undefined, cwd: string): ConfigFile | undefined =>
  configFile === undefined ? workingDirectoryConfigFile(cwd) : namedConfigFile(configFile, cwd);

const warnedDirectories = new Set<string>();

const warnOfNoConfig = (cwd: string): void => {
  const directory = path.resolve(cwd);

  if (warnedDirectories.has(directory)) {
    return;
  }

  warnedDirectories.add(directory);
  process.emitWarning(
    `No xrio.config in ${directory}, so this client has no configured proxy or host settings. Pass configFile to load one.`,
    { code: "XRIO_NO_CONFIG", type: "XrioWarning" },
  );
};

export const loadXrioConfig = (configFile?: string, cwd = process.cwd()): ResolvedConfig => {
  const file = locateConfigFile(configFile, cwd);

  if (file === undefined) {
    warnOfNoConfig(cwd);

    return EMPTY_CONFIG;
  }

  const config = file.read(file.path);

  return resolveSections(config);
};
