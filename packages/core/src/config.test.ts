import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect, promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadXrioConfig } from "./config.ts";
import { startFakeHttpProxy } from "./testing/fake-proxies.ts";
import { listenOnLoopback } from "./testing/fixture-server.ts";
import type { ClientOptions } from "./types.ts";

const directories: string[] = [];

// oxlint-disable-next-line typescript/strict-void-return -- Node explicitly provides the promisify overload for execFile.
const execute = promisify(execFile);

const NO_HOST = {
  browserArgs: undefined,
  identity: { display: undefined, hardware: undefined, locale: undefined, timezone: undefined },
};

const failureOf = (run: () => object): Error | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error : undefined;
  }

  return undefined;
};

const couldNotLoad = (file: string) =>
  `Could not load ${file}; use a synchronous default-exported object and Node-supported TypeScript syntax.`;

const noDefaultObject = (file: string) => `${file} must default-export a configuration object.`;

const notOneProxy = () => "proxy must be one object with a url string.";

const notJson = (file: string) => `Could not read ${file} as JSON.`;

const notOneObject = (file: string) => `${file} must contain one JSON object.`;

const unknownSections = () => "xrio.config supports only these top-level keys: host, proxy.";

const workspace = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xrio-config-"));

  directories.push(directory);

  return directory;
};

const scrapeLocaleInChild = async (directory: string, options: ClientOptions): Promise<string> => {
  const clientModule = new URL("client.ts", import.meta.url).href;

  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { createServer } from "node:http";
      import { XrioClient } from ${JSON.stringify(clientModule)};
      const origin = createServer((request, response) => {
        response.setHeader("content-type", "text/html");
        response.end("<p>ok</p>");
      });
      await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
      try {
        await using client = new XrioClient(${JSON.stringify(options)});
        const result = await client.scrape({ url: "http://127.0.0.1:" + origin.address().port + "/", format: "html", timeoutMs: 5000 });
        process.stdout.write(JSON.stringify({ locale: result.identity.locale }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
      } finally {
        origin.close();
      }
    `,
    ],
    { cwd: directory, encoding: "utf-8", timeout: 20_000 },
  );

  return stdout;
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
    expect(loadXrioConfig(undefined, directory).proxy?.url).toBe(url);
  });

  it("sends the config's host locale as Accept-Language on http scrapes", async () => {
    const acceptLanguages: (string | undefined)[] = [];

    const origin = createServer((request, response) => {
      acceptLanguages.push(request.headers["accept-language"]);
      response.setHeader("content-type", "text/html");
      response.end("<p>ok</p>");
    });

    const port = await listenOnLoopback(origin);
    const directory = workspace();
    const clientModule = new URL("client.ts", import.meta.url).href;

    writeFileSync(
      path.join(directory, "xrio.config.mjs"),
      'export default { host: { locale: "de-DE" } };',
    );

    try {
      const { stdout } = await execute(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { XrioClient } from ${JSON.stringify(clientModule)};
      await using client = new XrioClient({ mode: "http" });
      const result = await client.scrape({ url: "http://127.0.0.1:${port}/", format: "html", timeoutMs: 5000 });
      process.stdout.write(result.identity.locale);
    `,
        ],
        { cwd: directory, encoding: "utf-8", timeout: 20_000 },
      );

      expect(stdout).toBe("de-DE");
      expect(acceptLanguages).toStrictEqual(["de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7"]);
    } finally {
      origin.close();
    }
  });

  it("reads the file a client names, resolved against the working directory", async () => {
    const directory = workspace();

    mkdirSync(path.join(directory, "deploy"));
    writeFileSync(
      path.join(directory, "deploy", "staging.config.mjs"),
      'export default { host: { locale: "fr-FR" } };',
    );
    writeFileSync(
      path.join(directory, "xrio.config.mjs"),
      'export default { host: { locale: "ja-JP" } };',
    );

    const named = await scrapeLocaleInChild(directory, {
      configFile: "deploy/staging.config.mjs",
      mode: "http",
    });

    const discovered = await scrapeLocaleInChild(directory, { mode: "http" });

    expect([JSON.parse(named), JSON.parse(discovered)]).toStrictEqual([
      { locale: "fr-FR" },
      { locale: "ja-JP" },
    ]);
  });

  it("warns once per working directory when a client loads no config file", async () => {
    const empty = workspace();
    const configured = workspace();
    const clientModule = new URL("client.ts", import.meta.url).href;
    const named = path.join(configured, "xrio.config.mjs");

    writeFileSync(named, "export default {};");

    const warningsIn = async (directory: string, options: ClientOptions) => {
      const { stderr } = await execute(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
          import { XrioClient } from ${JSON.stringify(clientModule)};
          for (const round of [1, 2]) {
            await using client = new XrioClient(${JSON.stringify(options)});
          }
        `,
        ],
        { cwd: directory, encoding: "utf-8", timeout: 20_000 },
      );

      return stderr
        .split("\n")
        .filter((line) => line.includes("XrioWarning"))
        .map((line) => line.slice(line.indexOf("[XRIO_NO_CONFIG]")));
    };

    expect({
      configured: await warningsIn(configured, { mode: "http" }),
      empty: await warningsIn(empty, { mode: "http" }),
      named: await warningsIn(empty, { configFile: named, mode: "http" }),
    }).toStrictEqual({
      configured: [],
      empty: [
        `[XRIO_NO_CONFIG] XrioWarning: No xrio.config in ${realpathSync(empty)}, so this client has no configured proxy or host settings. Pass configFile to load one.`,
      ],
      named: [],
    });
  });

  it("rejects a named file that does not exist", () => {
    const directory = workspace();

    expect(() => loadXrioConfig("missing.config.mjs", directory)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: `configFile does not exist: ${path.join(directory, "missing.config.mjs")}`,
      }),
    );
  });

  it("rejects a named file with an unsupported extension", () => {
    const directory = workspace();

    writeFileSync(path.join(directory, "xrio.config.yaml"), "host: {}");

    expect(() => loadXrioConfig("xrio.config.yaml", directory)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: `configFile must end in .js, .json, .mjs, .mts, .ts: ${path.join(directory, "xrio.config.yaml")}`,
      }),
    );
  });

  it("reads only the working directory and rejects ambiguous filenames", () => {
    const directory = workspace();
    const child = path.join(directory, "child");

    mkdirSync(child);
    writeFileSync(
      path.join(directory, "xrio.config.mjs"),
      'export default { proxy: { url: "http://proxy.test" } };',
    );

    expect(loadXrioConfig(undefined, child)).toStrictEqual({ host: NO_HOST, proxy: undefined });

    writeFileSync(path.join(directory, "xrio.config.mts"), "export default {};");

    expect(() => loadXrioConfig(undefined, directory)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "Found multiple xrio.config files; keep exactly one in the working directory.",
      }),
    );
  });

  it("reads a JSON file a client names beside a module config", async () => {
    const directory = workspace();

    writeFileSync(
      path.join(directory, "staging.json"),
      JSON.stringify({ host: { locale: "fr-FR" } }),
    );
    writeFileSync(
      path.join(directory, "xrio.config.mjs"),
      'export default { host: { locale: "ja-JP" } };',
    );

    const outcome = await scrapeLocaleInChild(directory, {
      configFile: "staging.json",
      mode: "http",
    });

    expect(JSON.parse(outcome)).toStrictEqual({ locale: "fr-FR" });
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

describe("configuration file formats", () => {
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
        'export default { proxy: { url: "http://user-{session}:secret@proxy.test" }, };',
      );

      expect(loadXrioConfig(undefined, directory)).toStrictEqual({
        host: NO_HOST,
        proxy: {
          session: { format: "numeric", length: 8 },
          url: "http://user-{session}:secret@proxy.test",
        },
      });
    },
  );

  it.each([
    "{ browser: { futureSetting: true } }",
    '{ proxy: { url: "http://proxy.test" }, proxxy: {} }',
    '{ "http://user:secret@proxy.test": {} }',
  ])("rejects unknown top-level keys in %s", (config) => {
    const directory = workspace();

    writeFileSync(path.join(directory, "xrio.config.mjs"), `export default ${config};`);

    let failure: unknown;

    try {
      loadXrioConfig(undefined, directory);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "INVALID_OPTIONS",
      message: "xrio.config supports only these top-level keys: host, proxy.",
    });
    expect(inspect(failure, { depth: Infinity })).not.toContain("secret");
  });

  it("loads xrio.config.json", () => {
    const directory = workspace();

    writeFileSync(
      path.join(directory, "xrio.config.json"),
      JSON.stringify({
        host: { locale: "de-DE" },
        proxy: {
          session: { format: "alphanumeric", length: 12 },
          url: "http://u-{session}:p@proxy.test",
        },
      }),
    );

    expect(loadXrioConfig(undefined, directory)).toStrictEqual({
      host: { ...NO_HOST, identity: { ...NO_HOST.identity, locale: "de-DE" } },
      proxy: {
        session: { format: "alphanumeric", length: 12 },
        url: "http://u-{session}:p@proxy.test",
      },
    });
  });

  it("loads an xrio.config.json that starts with a byte order mark", () => {
    const directory = workspace();

    writeFileSync(
      path.join(directory, "xrio.config.json"),
      `\uFEFF${JSON.stringify({ host: { locale: "de-DE" } })}`,
    );

    expect(loadXrioConfig(undefined, directory)).toStrictEqual({
      host: { ...NO_HOST, identity: { ...NO_HOST.identity, locale: "de-DE" } },
      proxy: undefined,
    });
  });

  it("reads xrio.config.json from the working directory of the public client", async () => {
    const directory = workspace();

    writeFileSync(
      path.join(directory, "xrio.config.json"),
      JSON.stringify({ host: { locale: "ja-JP" } }),
    );

    const outcome = await scrapeLocaleInChild(directory, { mode: "http" });

    expect(JSON.parse(outcome)).toStrictEqual({ locale: "ja-JP" });
  });

  it("rejects a JSON file beside a module config in the working directory", () => {
    const directory = workspace();

    writeFileSync(path.join(directory, "xrio.config.json"), "{}");
    writeFileSync(path.join(directory, "xrio.config.mjs"), "export default {};");

    expect(() => loadXrioConfig(undefined, directory)).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "Found multiple xrio.config files; keep exactly one in the working directory.",
      }),
    );
  });

  it.each([
    ['{ "proxy": { "url": "http://user:secret@proxy.test", } }', notJson],
    ['{ "proxy": { "url": "http://user:secret@proxy.test" }', notJson],
    ["", notJson],
    ['["secret"]', notOneObject],
    ['"secret"', notOneObject],
    ["null", notOneObject],
    ['{ "secret": 1 }', unknownSections],
    ['{ "proxy": [{ "url": "http://secret@proxy.test" }] }', notOneProxy],
  ])("rejects unusable JSON without exposing its text: %s", (source, messageFor) => {
    const directory = workspace();
    const file = path.join(directory, "xrio.config.json");

    writeFileSync(file, source);

    const failure = failureOf(() => loadXrioConfig(undefined, directory));

    expect(failure).toMatchObject({ code: "INVALID_OPTIONS", message: messageFor(file) });
    expect(inspect(failure, { depth: Infinity })).not.toContain("secret");
  });

  it.each([
    ['throw new Error("secret");', couldNotLoad],
    ["export default [];", noDefaultObject],
    ["export default Promise.resolve({});", noDefaultObject],
    ["export default async () => ({});", noDefaultObject],
    ["export const proxy = {};", noDefaultObject],
    ["await Promise.resolve(); export default {};", couldNotLoad],
    ['export default { proxy: [{ url: "http://secret@proxy.test" }] };', notOneProxy],
  ])("rejects unusable modules without exposing their source: %s", (source, messageFor) => {
    const directory = workspace();
    const file = path.join(directory, "xrio.config.mjs");

    writeFileSync(file, source);

    let failure: unknown;

    try {
      loadXrioConfig(undefined, directory);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "INVALID_OPTIONS", message: messageFor(file) });
    expect(inspect(failure, { depth: Infinity })).not.toContain("secret");
  });
});
