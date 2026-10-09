import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import corePackage from "../../package.json" with { type: "json" };

const corePackageDir = path.resolve(import.meta.dirname, "..", "..");

export interface BenchEnvironment {
  readonly node: string;
  readonly platform: string;
  readonly chrome: { readonly path: string; readonly version: string; readonly sha256: string };
  readonly libraries: Readonly<Record<string, string>>;
}

const hasVersion = (manifest: unknown): manifest is { version: string } =>
  typeof manifest === "object" &&
  manifest !== null &&
  "version" in manifest &&
  typeof manifest.version === "string";

const installedVersion = (name: string): [string, string] => {
  const file = path.join(corePackageDir, "node_modules", name, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(file, "utf-8"));

  if (!hasVersion(manifest)) {
    throw new Error(`${file} has no version.`);
  }

  return [name, manifest.version];
};

const chromeVersion = (browserPath: string): string =>
  execFileSync(browserPath, ["--version"], { encoding: "utf-8" }).trim();

const sha256Of = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

export const describeEnvironment = (browserPath: string): BenchEnvironment => ({
  chrome: {
    path: browserPath,
    sha256: sha256Of(browserPath),
    version: chromeVersion(browserPath),
  },
  libraries: Object.fromEntries(Object.keys(corePackage.dependencies).map(installedVersion)),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
});
