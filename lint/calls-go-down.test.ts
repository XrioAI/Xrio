import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

const lint = (source: string, filename = "sources/browser/runtime.ts") => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-calls-go-down-"));
  const config = path.join(directory, "oxlint.json");
  const sourcePath = path.join(directory, "packages/core/src", filename);

  try {
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [fileURLToPath(new URL("xrio.ts", import.meta.url))],
        rules: { "xrio/calls-go-down": "error" },
      }),
    );
    writeFileSync(
      sourcePath,
      source.replaceAll("$ROOT", path.join(directory, "packages/core/src")),
    );

    return spawnSync(
      process.execPath,
      [oxlintPath, "--config", config, "--disable-nested-config", "--format", "json", sourcePath],
      { encoding: "utf-8", timeout: 10_000 },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

describe("calls-go-down lint", () => {
  it.each([
    {
      filename: "sources/browser/runtime.ts",
      source: "import { ProxyManager } from '../../proxy/manager.ts';",
    },
    {
      filename: "humanizer/humanizer.ts",
      source: "import { lookupProxyInfo } from '../proxy/info.ts';",
    },
    {
      filename: "sources/browser/runtime.ts",
      source: "import { sessions } from '../../sessions/session.ts';",
    },
    {
      filename: "sources/browser/runtime.ts",
      source: "import type { Hold } from '../../sessions/session.ts';",
    },
    {
      filename: "sources/browser/runtime.ts",
      source: "export { manager } from '../../proxy/routes.ts';",
    },
    { filename: "humanizer/humanizer.ts", source: "export * from '../proxy/exit.ts';" },
    {
      filename: "sources/browser/runtime.ts",
      source: "export const load = () => import('../../coordinator.ts');",
    },
    {
      filename: "sources/browser/runtime.ts",
      source: "export const load = () => import(`../../proxy/exit.ts`);",
    },
    {
      filename: "sources/browser/cdp/driver.ts",
      source: "import { manager } from '../../../proxy/route.ts';",
    },
    {
      filename: "humanizer/humanizer.ts",
      source: "import { manager } from '$ROOT/coordinator.ts';",
    },
  ])("rejects $source", ({ source, filename }) => {
    const result = lint(source, filename);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("cannot call upward");
  });

  it.each([
    {
      filename: "sources/browser/runtime.ts",
      source: "import type { VisitPlan } from '../visit.ts';",
    },
    { filename: "coordinator.ts", source: "import { sessions } from './sessions/session.ts';" },
    {
      filename: "humanizer/humanizer.ts",
      source: "import type { ExitFacts } from './contracts.ts';",
    },
  ])("allows $source", ({ source, filename }) => {
    expect(lint(source, filename).status).toBe(0);
  });
});
