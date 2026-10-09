import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "../client.ts";
import { fakeChromePath } from "../testing/fake-chrome-path.ts";

const PAGE = "https://fake.test/page";

const WATCHED_SWITCHES: ReadonlySet<string> = new Set(["--no-sandbox", "--enable-logging"]);

const isArgvEvent = (message: unknown): message is { event: "browser-argv"; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "browser-argv" &&
  "detail" in message &&
  typeof message.detail === "string";

const watchedSwitchesOf = (detail: string): string[] => {
  const argv: unknown = JSON.parse(detail);

  return Array.isArray(argv)
    ? argv.filter(
        (arg: unknown): arg is string => typeof arg === "string" && WATCHED_SWITCHES.has(arg),
      )
    : [];
};

const sharedStateDir = async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "xrio-browser-args-"));
  const configFile = path.join(stateDir, "xrio.config.json");
  const clients: XrioClient[] = [];
  const launches: string[][] = [];

  const recordLaunch: ChannelListener = (message) => {
    if (isArgvEvent(message)) {
      launches.push(watchedSwitchesOf(message.detail));
    }
  };

  await writeFile(configFile, "{}");
  subscribe("xrio:event", recordLaunch);

  const client = async (browserArgs?: readonly string[], scenario = "normal") => {
    const created = new XrioClient({
      browserArgs,
      browserPath: await fakeChromePath(scenario),
      configFile,
      mode: "headless",
      stateDir,
    });

    clients.push(created);

    return created;
  };

  return {
    [Symbol.asyncDispose]: async () => {
      unsubscribe("xrio:event", recordLaunch);
      await Promise.all(
        clients.map(async (created) => {
          await created.close();
        }),
      );
      await rm(stateDir, { force: true, recursive: true });
    },
    client,
    launches,
    stateDir,
  };
};

describe("a session's browserArgs", () => {
  it("launch a later scrape whose client sets none", async () => {
    await using shared = await sharedStateDir();
    const sandboxed = await shared.client(["--no-sandbox"]);
    const plain = await shared.client();

    await sandboxed.scrape({ format: "html", session: "account", url: PAGE });
    await plain.scrape({ format: "html", session: "account", url: PAGE });
    await plain.scrape({ format: "html", url: PAGE });

    expect(shared.launches).toStrictEqual([["--no-sandbox"], ["--no-sandbox"], []]);
  });

  it("refuse a client with another non-empty list and accept the same list", async () => {
    await using shared = await sharedStateDir();
    const sandboxed = await shared.client(["--no-sandbox"]);
    const logging = await shared.client(["--enable-logging"]);

    await sandboxed.scrape({ format: "html", session: "account", url: PAGE });

    const refused = logging.scrape({ format: "html", session: "account", url: PAGE });

    await expect(refused).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(refused).rejects.toThrow(
      'The session\'s device record fixes its browserArgs to ["--no-sandbox"].',
    );
    await expect(
      sandboxed.scrape({ format: "html", session: "account", url: PAGE }),
    ).resolves.toMatchObject({ url: PAGE });
    expect(shared.launches).toStrictEqual([["--no-sandbox"], ["--no-sandbox"]]);
  });

  it("refuse a stored list that holds a switch Xrio manages", async () => {
    await using shared = await sharedStateDir();
    const sandboxed = await shared.client(["--no-sandbox"]);

    await sandboxed.scrape({ format: "html", session: "account", url: PAGE });

    const database = new DatabaseSync(path.join(shared.stateDir, "xrio.db"));

    try {
      database.exec(
        `PRAGMA busy_timeout=1000; UPDATE sessions SET browser_args='["--no-sandbox","--user-data-dir=/tmp/elsewhere"]'`,
      );
    } finally {
      database.close();
    }

    const plain = await shared.client();
    const refused = plain.scrape({ format: "html", session: "account", url: PAGE });

    await expect(refused).rejects.toMatchObject({
      cause: {
        code: "INVALID_OPTIONS",
        message: "The stored browserArgs cannot include --user-data-dir, which Xrio manages.",
      },
      code: "SESSION_UNAVAILABLE",
      details: { reason: "record-refused" },
      message: "The session's stored browserArgs cannot be replayed.",
    });
    expect(shared.launches).toStrictEqual([["--no-sandbox"]]);
  });

  it("are not stored by a first visit that failed", async () => {
    await using shared = await sharedStateDir();
    const failing = await shared.client(["--no-sandbox"], "navigate-error");
    const logging = await shared.client(["--enable-logging"]);

    await expect(
      failing.scrape({ format: "html", session: "account", url: PAGE }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await expect(
      logging.scrape({ format: "html", session: "account", url: PAGE }),
    ).resolves.toMatchObject({ url: PAGE });
    expect(shared.launches).toStrictEqual([["--no-sandbox"], ["--enable-logging"]]);
  });

  it("move a pool claim to another member when they differ from the client's", async () => {
    await using shared = await sharedStateDir();
    const sandboxed = await shared.client(["--no-sandbox"]);
    const logging = await shared.client(["--enable-logging"]);
    const session = { pool: "catalog", size: 2 };

    await expect(sandboxed.scrape({ format: "html", session, url: PAGE })).resolves.toMatchObject({
      session: { created: true, name: "catalog/1" },
    });
    await sandboxed.close();
    await expect(logging.scrape({ format: "html", session, url: PAGE })).resolves.toMatchObject({
      session: { created: true, name: "catalog/2" },
    });
    expect(shared.launches).toStrictEqual([["--no-sandbox"], ["--enable-logging"]]);
  });
});
