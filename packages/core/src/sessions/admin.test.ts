import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "../client.ts";
import { startDeadline } from "../deadline.ts";
import { resolveClientOptions, resolveScrapeIntent } from "../options.ts";
import { fakeChromePath } from "../testing/fake-chrome-path.ts";
import { processStart, profileDirectory } from "./profiles.ts";
import { createSessions } from "./session.ts";
import { SessionStore } from "./store.ts";

const intent = resolveScrapeIntent(
  { format: "html", session: "account", url: "https://example.com" },
  resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
);

const profileUse = async () => await Promise.resolve("clear" as const);

const PAGE = "https://fake.test/page";

const exists = async (directory: string): Promise<boolean> => {
  try {
    await lstat(directory);

    return true;
  } catch {
    return false;
  }
};

const sessionClient = async (mode: "headless" | "http" = "headless") => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "xrio-sessions-"));
  const configFile = path.join(stateDir, "xrio.config.json");
  await writeFile(configFile, "{}");

  const client =
    mode === "http"
      ? new XrioClient({ configFile, mode, stateDir })
      : new XrioClient({ browserPath: await fakeChromePath("normal"), configFile, mode, stateDir });

  return {
    [Symbol.asyncDispose]: async () => {
      await client.close();
      await rm(stateDir, { force: true, recursive: true });
    },
    client,
    stateDir,
  };
};

describe("session administration", () => {
  it("refuses an admin reference captured before the client closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-admin-"));
    const sessions = createSessions(root, { profileUse });
    const { admin } = sessions;

    try {
      await sessions.close();
      await expect(admin.list()).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
      await expect(admin.delete("account")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
      await expect(admin.prune({ idleFor: 0 })).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("finishes a previously accepted delete while close waits for its active owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-admin-"));
    const sessions = createSessions(root, { profileUse });
    using deadline = startDeadline(10_000);

    const hold = await sessions.hold(
      intent.session,
      {
        capabilities: { chromeMajor: 154, permittedCpus: 32, platform: "linux" },
        seed: () => "9f2c41d07a3be815",
      },
      deadline,
    );

    try {
      const deleting = sessions.admin.delete("account");
      const closing = sessions.close();
      await hold[Symbol.asyncDispose]();
      await deleting;
      await closing;
      await expect(exists(profileDirectory(root, "local", "account"))).resolves.toBeFalsy();
    } finally {
      await hold[Symbol.asyncDispose]();
      await sessions.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("prunes a session whose holder died and skips one whose holder is alive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-admin-"));
    const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(exited, "exit");
    const store = new SessionStore(root);
    using deadline = startDeadline(10_000);

    const held = async (name: string, pid: number, start: string) => {
      await store.claimSession(
        name,
        {
          check: () => {},
          dead: new Set<string>(),
          grace: 5000,
          holder: { host: hostname(), pid, start, token: name },
          length: 60_000,
          major: 154,
          now: Date.now() - 1000,
          stickyId: randomUUID,
        },
        deadline,
      );
    };

    await held("crashed", exited.pid ?? 0, "gone");
    await held("running", process.pid, (await processStart(process.pid)) ?? "");
    store.close();
    const sessions = createSessions(root, { profileUse });

    try {
      const pruned = await sessions.admin.prune({ idleFor: 0 });
      const listed = await sessions.admin.list();

      expect({ left: listed.map(({ name }) => name), pruned }).toStrictEqual({
        left: ["running"],
        pruned: ["crashed"],
      });
    } finally {
      await sessions.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("drains a list accepted before close even while the store is opening", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-admin-"));
    const sessions = createSessions(root, { profileUse });

    try {
      const listing = sessions.admin.list();
      const closing = sessions.close();
      await expect(listing).resolves.toStrictEqual([]);
      await closing;
    } finally {
      await sessions.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("sessions through the public client", () => {
  it("lists, deletes and prunes sessions with their profiles", async () => {
    await using visited = await sessionClient();
    const { client, stateDir } = visited;

    const rows = async () => {
      const listed = await client.sessions.list();

      return listed.map(({ name, state, visits }) => ({ name, state, visits }));
    };

    const profiles = async () =>
      await Promise.all(
        ["alpha", "beta"].map(
          async (name) => await exists(profileDirectory(stateDir, "local", name)),
        ),
      );

    await client.scrape({ format: "html", session: "alpha", url: PAGE });
    await client.scrape({ format: "html", session: "beta", url: PAGE });

    await expect.poll(rows).toStrictEqual([
      { name: "alpha", state: "ready", visits: 1 },
      { name: "beta", state: "ready", visits: 1 },
    ]);

    await client.sessions.delete("never-made");
    await client.sessions.delete("alpha");

    const deleted = {
      profiles: await profiles(),
      pruned: await client.sessions.prune({ idleFor: 3_600_000 }),
      rows: await rows(),
    };

    expect(deleted).toStrictEqual({
      profiles: [false, true],
      pruned: [],
      rows: [{ name: "beta", state: "ready", visits: 1 }],
    });

    const pruned = await client.sessions.prune({ idleFor: 0 });

    expect({ profiles: await profiles(), pruned, rows: await rows() }).toStrictEqual({
      profiles: [false, false],
      pruned: ["beta"],
      rows: [],
    });
  });

  it.each([
    { reason: "browser-too-old", stored: "chrome_major=9999" },
    { reason: "cannot-present", stored: "platform='plan9'" },
    { reason: "record-refused", stored: "record='{'" },
  ])("refuses a session scrape with $reason when it stored $stored", async ({ reason, stored }) => {
    await using visited = await sessionClient();
    const { client, stateDir } = visited;

    await client.scrape({ format: "html", session: "account", url: PAGE });
    await expect
      .poll(async () => await client.sessions.list())
      .toMatchObject([{ name: "account", visits: 1 }]);

    const database = new DatabaseSync(path.join(stateDir, "xrio.db"));

    try {
      database.exec(`PRAGMA busy_timeout=1000; UPDATE sessions SET ${stored} WHERE name='account'`);
    } finally {
      database.close();
    }

    await expect(
      client.scrape({ format: "html", session: "account", url: PAGE }),
    ).rejects.toMatchObject({ code: "SESSION_UNAVAILABLE", details: { reason } });
  });

  it("refuses a session scrape with INVALID_OPTIONS naming a stateDir that others can read", async () => {
    await using visited = await sessionClient();
    const { client, stateDir } = visited;
    await chmod(stateDir, 0o755);

    const scrape = client.scrape({ format: "html", session: "account", url: PAGE });

    await expect(scrape).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(scrape).rejects.toThrow(stateDir);
  });

  it("removes a leftover deleted profile when the store opens", async () => {
    await using visited = await sessionClient("http");
    const { client, stateDir } = visited;
    const profiles = path.join(stateDir, "profiles");
    const tombstone = path.join(profiles, "0123456789abcdef.removed-5f1d7a0e");

    await mkdir(path.join(profiles, "fedcba9876543210"), { recursive: true });
    await mkdir(tombstone, { recursive: true });
    await writeFile(path.join(tombstone, "Cookies"), "left behind");

    await expect(client.sessions.list()).resolves.toStrictEqual([]);
    await expect(readdir(profiles)).resolves.toStrictEqual(["fedcba9876543210"]);
  });
});
