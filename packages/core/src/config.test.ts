import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadXrioConfig } from "./config.ts";

const directories: string[] = [];

const workspace = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-config-"));

  directories.push(directory);

  return directory;
};

describe("configuration discovery", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each(["ts", "mts", "js", "mjs"])(
    "loads a synchronous default export from xrio.config.%s",
    (extension) => {
      const directory = workspace();

      writeFileSync(path.join(directory, "package.json"), '{"type":"module"}');
      writeFileSync(
        path.join(directory, `xrio.config.${extension}`),
        'export default { proxy: { url: "http://user-{session}:secret@proxy.test" }, browser: { futureSetting: true } };',
      );

      expect(loadXrioConfig(directory)).toStrictEqual({
        browser: { futureSetting: true },
        proxy: {
          session: { format: "numeric", length: 8 },
          url: "http://user-{session}:secret@proxy.test",
        },
      });
    },
  );

  it("does not search parents and rejects ambiguous filenames", () => {
    const directory = workspace();
    const child = path.join(directory, "child");

    mkdirSync(child);
    writeFileSync(
      path.join(directory, "xrio.config.mjs"),
      'export default { proxy: { url: "http://proxy.test" } };',
    );

    expect(loadXrioConfig(child)).toStrictEqual({});

    writeFileSync(path.join(directory, "xrio.config.mts"), "export default {};");

    expect(() => loadXrioConfig(directory)).toThrow("multiple xrio.config files");
  });

  it.each([
    'throw new Error("secret");',
    "export default [];",
    "export default Promise.resolve({});",
    "export default async () => ({});",
    "export const proxy = {};",
    "await Promise.resolve(); export default {};",
    'export default { proxy: [{ url: "http://secret@proxy.test" }] };',
  ])("rejects unusable modules without exposing their source: %s", (source) => {
    const directory = workspace();

    writeFileSync(path.join(directory, "xrio.config.mjs"), source);

    let failure: unknown;

    try {
      loadXrioConfig(directory);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "INVALID_OPTIONS" });
    expect(inspect(failure, { depth: Infinity })).not.toContain("secret");
  });

  it("loads configuration explicitly before passing its proxy section to the manager", () => {
    const directory = workspace();
    const managerModule = new URL("proxy/manager.ts", import.meta.url).href;
    const configModule = new URL("config.ts", import.meta.url).href;

    writeFileSync(
      path.join(directory, "xrio.config.mts"),
      'export default { proxy: { url: "http://user-{session}:secret@proxy.test" } } satisfies { proxy: { url: string } };',
    );

    const stdout = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { ProxyManager } from ${JSON.stringify(managerModule)};
      import { loadXrioConfig } from ${JSON.stringify(configModule)};
      const config = loadXrioConfig();
      const manager = new ProxyManager(config.proxy);
      process.stdout.write(manager.getProxyConnectionString());
    `,
      ],
      { cwd: directory, encoding: "utf-8" },
    );

    expect(stdout).toMatch(/^http:\/\/user-\d{8}:secret@proxy\.test$/u);
  });

  it("does not execute configuration from the working directory during manager construction", () => {
    const directory = workspace();
    const managerModule = new URL("proxy/manager.ts", import.meta.url).href;

    writeFileSync(
      path.join(directory, "xrio.config.mjs"),
      'process.stdout.write("Unexpected config load"); export default {};',
    );

    const stdout = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { ProxyManager } from ${JSON.stringify(managerModule)};
      try { new ProxyManager(); } catch (error) {
        if (error.code !== "INVALID_OPTIONS") throw error;
      }
      const manager = new ProxyManager({ url: "http://proxy.test:8080" });
      process.stdout.write(manager.getProxyConnectionString());
    `,
      ],
      { cwd: directory, encoding: "utf-8" },
    );

    expect(stdout).toBe("http://proxy.test:8080");
  });
});
