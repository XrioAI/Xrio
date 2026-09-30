import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

describe("anti-slop dependency patch", () => {
  it("custom anti-slop rules reject repeated array work and fix missing spacing", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "xrio-anti-slop-"));
    const configPath = path.join(directory, "oxlint.json");
    const sourcePath = path.join(directory, "sample.ts");

    const oxlintPath = fileURLToPath(
      new URL("bin/oxlint", import.meta.resolve("oxlint/package.json")),
    );

    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          categories: { correctness: "off" },
          jsPlugins: [
            {
              name: "anti-slop",
              specifier: fileURLToPath(
                new URL("plugin.mjs", import.meta.resolve("ultracite/oxlint/anti-slop")),
              ),
            },
          ],
          rules: {
            "anti-slop/no-array-filter-map": "error",
            "anti-slop/no-reduce-accumulator-copy": "error",
            "anti-slop/require-readable-spacing": "error",
          },
        }),
      );
      writeFileSync(
        sourcePath,
        "export const doubled = [1, 2].filter(Boolean).map((value) => value * 2);\n" +
          "export const copied = [1, 2].reduce((all, value) => all.concat(value), []);\n",
      );

      const result = spawnSync(
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

      expect(result).toMatchObject({ status: 1, stderr: "" });
      expect(result.stdout).toContain("no-array-filter-map");
      expect(result.stdout).toContain("no-reduce-accumulator-copy");
      expect(result.stdout).toContain("require-readable-spacing");

      writeFileSync(sourcePath, "export const first = 1;\nexport const second = 2;\n");

      const fixed = spawnSync(
        process.execPath,
        [oxlintPath, "--config", configPath, "--disable-nested-config", "--fix", sourcePath],
        { encoding: "utf-8", timeout: 10_000 },
      );

      expect({
        error: fixed.error,
        source: readFileSync(sourcePath, "utf-8"),
        status: fixed.status,
        stderr: fixed.stderr,
      }).toStrictEqual({
        error: undefined,
        source: "export const first = 1;\n\nexport const second = 2;\n",
        status: 0,
        stderr: "",
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
