import { homedir } from "node:os";
import path from "node:path";

import { invalidOptions } from "./errors.ts";

export class CacheDir {
  readonly path: string;

  constructor(directory: string) {
    if (directory.trim() === "") {
      throw invalidOptions("cacheDir must be a non-empty directory path.");
    }

    this.path = path.resolve(directory);
  }
}

const xdgCacheHome = (): string => {
  const configured = process.env.XDG_CACHE_HOME;

  return configured === undefined || configured === ""
    ? path.join(homedir(), ".cache")
    : configured;
};

export const defaultCacheDir = (): CacheDir =>
  new CacheDir(
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Caches", "xrio")
      : path.join(xdgCacheHome(), "xrio"),
  );

export const hostCacheRoot = (cacheDir = defaultCacheDir()): string =>
  path.join(cacheDir.path, "host");
