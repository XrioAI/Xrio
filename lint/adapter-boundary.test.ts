import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const oxlintPath = fileURLToPath(new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")));

const lint = (source: string) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-adapter-boundary-"));
  const configPath = path.join(directory, "oxlint.json");
  const sourcePath = path.join(directory, "driver.ts");

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [fileURLToPath(new URL("adapter-boundary.ts", import.meta.url))],
        rules: { "xrio/adapter-boundary": "error" },
      }),
    );
    writeFileSync(sourcePath, source);

    return spawnSync(
      process.execPath,
      [
        oxlintPath,
        "--config",
        configPath,
        "--disable-nested-config",
        "--format",
        "json",
        sourcePath,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

describe("adapter-boundary lint rule", () => {
  it("rejects emulation options and page-altering calls", () => {
    const result = lint(
      [
        "declare const page: { route(): void; routeFromHAR(): void; exposeFunction(): void; addInitScript(): void };",
        "export const options = { locale: 'en-US', proxy: {}, timezoneId: 'UTC', userAgent: 'x',",
        "  viewport: { height: 1, width: 1 }, extraHTTPHeaders: {} };",
        "page.route();",
        "page.exposeFunction();",
        "page.addInitScript();",
        'page["routeFromHAR"]();',
        "",
      ].join("\n"),
    );

    expect(result).toMatchObject({ status: 1, stderr: "" });

    for (const name of [
      "locale",
      "proxy",
      "timezoneId",
      "userAgent",
      "viewport",
      "extraHTTPHeaders",
      "route",
      "exposeFunction",
      "addInitScript",
      "routeFromHAR",
    ]) {
      expect(result.stdout).toContain(`\`${name}\``);
    }
  });

  it("allows switching viewport emulation off", () => {
    expect(lint("export const options = { viewport: null, headless: true };\n")).toMatchObject({
      status: 0,
      stderr: "",
    });
  });
});
