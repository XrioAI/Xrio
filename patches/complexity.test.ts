import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

describe("complexity dependency patch", () => {
  it("components skip both complexity checks while handlers and utilities retain them", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "xrio-complexity-"));
    const configPath = path.join(directory, "oxlint.json");
    const sourcePath = path.join(directory, "components.tsx");

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
              name: "complexity",
              specifier: fileURLToPath(import.meta.resolve("oxlint-plugin-complexity")),
            },
          ],
          rules: {
            "complexity/complexity": [
              "error",
              { cognitive: 1, cyclomatic: 2, enableExtraction: false, minLines: 0 },
            ],
          },
        }),
      );

      writeFileSync(
        sourcePath,
        `
export function Component(first, second) {
  function handleClick() {
    if (first) {
      if (second) return 1;
    }
    return 0;
  }
  const handleChange = () => {
    if (first) {
      if (second) return 1;
    }
    return 0;
  };
  if (first) return null;
  return <button onClick={handleClick} onBlur={handleChange}>{second ? "yes" : "no"}</button>;
}
export const GenericComponent = <T,>(props: T) => {
  if (!props) return null;
  return props ? <div /> : <span />;
};
export const ImplicitComponent = (first, second) =>
  <div>{first ? (second ? "both" : "first") : "neither"}</div>;
export const FragmentComponent = (first, second) => {
  if (first) return null;
  return <>{second ? "yes" : "no"}</>;
};
export function ConditionalComponent(first, second) {
  if (first) return null;
  return second ? <div /> : <span />;
}
export function EarlyReturnComponent(first, second) {
  if (first) {
    if (second) return <div />;
  }
  return null;
}
export const ShortCircuitComponent = (first, second) => {
  if (first) return null;
  return second && <div />;
};
export const AssertedComponent = (first, second) => {
  if (first) return null;
  return (second ? <div /> : <span />) as unknown;
};
export function BuildConfig(first, second) {
  if (first) return second ? 1 : 2;
  return 0;
}
export function Factory(first, second) {
  const render = () => <div />;
  if (first) return second ? render : null;
  return null;
}
export function renderContent(first, second) {
  if (first) return null;
  return second ? <div /> : <span />;
}
export function Predicate(first, second) {
  if (first) return false;
  return <div /> && first && second;
}
`,
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

      for (const name of [
        "Component",
        "GenericComponent",
        "ImplicitComponent",
        "FragmentComponent",
        "ConditionalComponent",
        "EarlyReturnComponent",
        "ShortCircuitComponent",
        "AssertedComponent",
      ]) {
        expect(result.stdout).not.toContain(`Function '${name}' has Cognitive Complexity`);
        expect(result.stdout).not.toContain(`Function '${name}' has cyclomatic complexity`);
      }

      for (const name of [
        "handleClick",
        "handleChange",
        "BuildConfig",
        "Factory",
        "renderContent",
        "Predicate",
      ]) {
        expect(result.stdout).toContain(`Function '${name}' has Cognitive Complexity`);
        expect(result.stdout).toContain(`Function '${name}' has cyclomatic complexity`);
      }
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
