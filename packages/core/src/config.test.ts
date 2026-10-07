import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadXrioConfig } from "./config.ts";
import { startFakeHttpProxy } from "./testing/fake-proxies.ts";

const directories: string[] = [];

// oxlint-disable-next-line typescript/strict-void-return -- Node explicitly provides the promisify overload for execFile.
const execute = promisify(execFile);

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

  it("connects config to the public client once, with method and client proxy precedence", async () => {
    await using configured = await startFakeHttpProxy({ connectStatus: 407, tunnelTo: 0 });
    await using clientProxy = await startFakeHttpProxy({ connectStatus: 407, tunnelTo: 0 });
    await using methodProxy = await startFakeHttpProxy({ connectStatus: 407, tunnelTo: 0 });
    const directory = workspace();
    const elsewhere = workspace();
    const clientModule = new URL("client.ts", import.meta.url).href;
    const url = configured.url.replace("://", "://configured-{session}:secret@");
    const source = `export default ${JSON.stringify({ proxy: { url } })};`;

    writeFileSync(path.join(directory, "xrio.config.mjs"), source);
    writeFileSync(
      path.join(elsewhere, "xrio.config.mjs"),
      "throw new Error('Config was rediscovered during a scrape');",
    );

    const { stdout } = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { XrioClient } from ${JSON.stringify(clientModule)};
      await using configured = new XrioClient({ mode: "http" });
      await using overridden = new XrioClient({ mode: "http", proxy: ${JSON.stringify(clientProxy.url)} });
      process.chdir(${JSON.stringify(elsewhere)});
      const codes = [];
      for (const [client, proxy] of [[configured], [overridden], [overridden, ${JSON.stringify(methodProxy.url)}], [configured]]) {
        try { await client.scrape({ url: "https://target.invalid/", format: "html", proxy, timeoutMs: 5000 }); }
        catch (error) { codes.push(error.code); }
      }
      process.stdout.write(JSON.stringify(codes));
    `,
      ],
      { cwd: directory, encoding: "utf-8", timeout: 20_000 },
    );

    expect(JSON.parse(stdout)).toStrictEqual(Array.from({ length: 4 }, () => "PROXY_AUTH_FAILED"));
    expect([
      configured.requests.length,
      clientProxy.requests.length,
      methodProxy.requests.length,
    ]).toStrictEqual([2, 1, 1]);
    expect(configured.requests[0]).toStrictEqual(configured.requests[1]);
    expect(
      Buffer.from(configured.requests[0].authorization?.slice(6) ?? "", "base64").toString(),
    ).toMatch(/^configured-\d{8}:secret$/u);
    expect(loadXrioConfig(directory).proxy?.url).toBe(url);
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
