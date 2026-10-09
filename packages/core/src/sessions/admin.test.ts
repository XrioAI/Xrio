import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "../client.ts";
import { startDeadline } from "../deadline.ts";
import { resolveClientOptions, resolveScrapeIntent } from "../options.ts";
import { attemptLog } from "../testing/attempt-log.ts";
import { fakeChromePath } from "../testing/fake-chrome-path.ts";
import type { SessionInfo } from "../types.ts";
import { processStart, storedProfile } from "./profiles.ts";
import { createSessions } from "./session.ts";
import type { SessionManager } from "./session.ts";
import { SessionStore } from "./store.ts";

const intent = resolveScrapeIntent(
  { format: "html", session: "account", url: "https://example.com" },
  resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
);

const profileUse = async () => await Promise.resolve("clear" as const);

const PAGE = "https://fake.test/page";

const ACCOUNT_PROFILE = "34b999a96c2c821a";

const exists = async (directory: string): Promise<boolean> => {
  try {
    await lstat(directory);

    return true;
  } catch {
    return false;
  }
};

const fileMode = async (file: string): Promise<number> => {
  const stats = await stat(file);

  return stats.mode % 0o1000;
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

const claimChecks = {
  capabilities: { chromeMajor: 154, permittedCpus: 32, platform: "linux" },
  seed: () => "9f2c41d07a3be815",
} as const;

const createdSession = async (sessions: SessionManager, name: string): Promise<void> => {
  using deadline = startDeadline(10_000);

  const { session } = resolveScrapeIntent(
    { format: "html", session: name, url: PAGE },
    resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
  );

  const hold = await sessions.hold(session, claimChecks, deadline);
  await hold[Symbol.asyncDispose]();
};

const macSessions = async () => {
  const home = await mkdtemp(path.join(tmpdir(), "xrio-home-"));
  const root = path.join(home, "Library", "Application Support", "xrio");

  const sessions = createSessions(root, {
    cacheHost: { home: () => home, platform: "darwin" },
    profileUse,
  });

  return {
    [Symbol.asyncDispose]: async () => {
      await sessions.close();
      await rm(home, { force: true, recursive: true });
    },
    caches: path.join(home, "Library", "Caches", "xrio", "profiles"),
    home,
    root,
    sessions,
  };
};

const isSweepIncomplete = (
  message: unknown,
): message is { event: "sweep-incomplete"; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  message.event === "sweep-incomplete" &&
  "detail" in message &&
  typeof message.detail === "string";

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
      await expect(admin.visits("account")).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
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
      await expect(exists(path.join(root, storedProfile("local", "account")))).resolves.toBeFalsy();
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

  it("removes a session's cache under ~/Library/Caches with it and keeps a --disk-cache-dir directory", async () => {
    await using mac = await macSessions();
    const { caches, home, root, sessions } = mac;
    const shared = path.join(home, "shared-cache");

    await createdSession(sessions, "account");
    await createdSession(sessions, "shared");

    const database = new DatabaseSync(path.join(root, "xrio.db"));

    try {
      database.exec("PRAGMA busy_timeout=1000");
      database
        .prepare("UPDATE sessions SET browser_args=? WHERE name='shared'")
        .run(JSON.stringify([`--disk-cache-dir=${shared}`]));
    } finally {
      database.close();
    }

    const listed = await sessions.admin.list();

    await Promise.all(
      listed.map(async ({ cacheDir }) => {
        await mkdir(cacheDir, { recursive: true });
      }),
    );
    await sessions.admin.delete("account");
    await sessions.admin.delete("shared");

    expect({
      cacheDirs: listed.map(({ cacheDir }) => cacheDir),
      left: {
        accountCache: await exists(path.join(caches, ACCOUNT_PROFILE)),
        accountProfile: await exists(path.join(root, "profiles", ACCOUNT_PROFILE)),
        otherCaches: await exists(caches),
        sharedCache: await exists(path.join(shared, "Default", "Cache")),
      },
    }).toStrictEqual({
      cacheDirs: [
        path.join(caches, ACCOUNT_PROFILE, "Default", "Cache"),
        path.join(shared, "Default", "Cache"),
      ],
      left: { accountCache: false, accountProfile: false, otherCaches: true, sharedCache: true },
    });
  });

  it("empties a record-less session's cache under ~/Library/Caches before its next scrape and keeps a recorded one's", async () => {
    await using mac = await macSessions();
    const { root, sessions } = mac;

    await createdSession(sessions, "account");
    await createdSession(sessions, "recorded");

    const database = new DatabaseSync(path.join(root, "xrio.db"));

    try {
      database.exec(
        "PRAGMA busy_timeout=1000; UPDATE sessions SET record='{}' WHERE name='recorded'",
      );
    } finally {
      database.close();
    }

    const listed = await sessions.admin.list();

    await Promise.all(
      listed.map(async ({ cacheDir }) => {
        await mkdir(cacheDir, { recursive: true });
        await writeFile(path.join(cacheDir, "entry"), "cached");
      }),
    );

    using deadline = startDeadline(10_000);

    const cachedWhileHeld = async ({ cacheDir, name }: SessionInfo) => {
      const hold = await sessions.hold({ kind: "named", name }, claimChecks, deadline);

      try {
        return [name, await exists(path.join(cacheDir, "entry"))] as const;
      } finally {
        await hold[Symbol.asyncDispose]();
      }
    };

    expect(Object.fromEntries(await Promise.all(listed.map(cachedWhileHeld)))).toStrictEqual({
      account: false,
      recorded: true,
    });
  });

  it("holds and deletes a session whose cache it cannot remove and publishes sweep-incomplete each time", async () => {
    await using mac = await macSessions();
    const { caches, sessions } = mac;
    const failures: string[] = [];

    const record: ChannelListener = (message) => {
      if (isSweepIncomplete(message)) {
        failures.push(message.detail);
      }
    };

    await createdSession(sessions, "account");
    await mkdir(path.join(caches, ACCOUNT_PROFILE, "Default", "Cache"), { recursive: true });
    await chmod(caches, 0o500);
    subscribe("xrio:event", record);

    try {
      await createdSession(sessions, "account");
      await sessions.admin.delete("account");

      expect({ failures, listed: await sessions.admin.list() }).toStrictEqual({
        failures: [
          expect.stringMatching(/^Removing the cache of session account failed: /u),
          expect.stringMatching(/^Removing the cache of session account failed: /u),
        ],
        listed: [],
      });
    } finally {
      unsubscribe("xrio:event", record);
      await chmod(caches, 0o700);
    }
  });

  it("counts every outcome of the visit log in list(), unknown included", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-admin-"));
    const sessions = createSessions(root, { profileUse });
    using deadline = startDeadline(10_000);

    try {
      {
        await using hold = await sessions.hold(intent.session, claimChecks, deadline);
        await hold.logAttempt(attemptLog({ outcome: "unknown" }));
        await hold.logAttempt(attemptLog({ outcome: "ok" }));
        await hold.logAttempt(attemptLog({ outcome: "unknown" }));
      }

      const [listed] = await sessions.admin.list();

      expect(listed?.outcomes).toStrictEqual({
        blocked: 0,
        failed: 0,
        ok: 1,
        queued: 0,
        suspect: 0,
        unknown: 2,
      });
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
          async (name) => await exists(path.join(stateDir, storedProfile("local", name))),
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

  it("reports the profile and cache paths in a scrape's result and in list()", async () => {
    await using visited = await sessionClient();
    const { client, stateDir } = visited;
    const profileDir = path.join(stateDir, "profiles", ACCOUNT_PROFILE);
    const paths = { cacheDir: path.join(profileDir, "Default", "Cache"), profileDir };

    const result = await client.scrape({ format: "html", session: "account", url: PAGE });

    expect(result.session).toMatchObject(paths);
    await expect(client.sessions.list()).resolves.toMatchObject([{ name: "account", ...paths }]);
    await expect(readdir(path.join(profileDir, "Default"))).resolves.toContain("Preferences");
  });

  it("resolves a session's profile from its stored path after stateDir moves", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "xrio-moved-"));
    const configFile = path.join(parent, "xrio.config.json");
    const created = path.join(parent, "created");
    const moved = path.join(parent, "moved");
    const browserPath = await fakeChromePath("normal");
    await writeFile(configFile, "{}");

    try {
      {
        await using client = new XrioClient({
          browserPath,
          configFile,
          mode: "headless",
          stateDir: created,
        });

        const first = await client.scrape({ format: "html", session: "account", url: PAGE });

        await writeFile(path.join(first.session?.profileDir ?? created, "kept"), "yes");
      }

      await rename(created, moved);

      await using client = new XrioClient({
        browserPath,
        configFile,
        mode: "headless",
        stateDir: moved,
      });

      const resumed = await client.scrape({ format: "html", session: "account", url: PAGE });
      const database = new DatabaseSync(path.join(moved, "xrio.db"), { readOnly: true });

      try {
        expect({
          kept: await readFile(path.join(resumed.session?.profileDir ?? moved, "kept"), "utf-8"),
          session: resumed.session,
          stored: database.prepare("SELECT profile_dir FROM sessions").all(),
        }).toMatchObject({
          kept: "yes",
          session: {
            created: false,
            profileDir: path.join(moved, "profiles", ACCOUNT_PROFILE),
            visits: 2,
          },
          stored: [{ profile_dir: `profiles/${ACCOUNT_PROFILE}` }],
        });
      } finally {
        database.close();
      }
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("refuses a stored profile path outside stateDir's profiles and leaves that directory alone", async () => {
    await using visited = await sessionClient();
    const { client, stateDir } = visited;
    const outside = path.join(stateDir, "outside");

    await client.scrape({ format: "html", session: "account", url: PAGE });
    await mkdir(outside);

    const database = new DatabaseSync(path.join(stateDir, "xrio.db"));

    try {
      database.exec("PRAGMA busy_timeout=1000; UPDATE sessions SET profile_dir='outside'");
    } finally {
      database.close();
    }

    await expect(client.sessions.delete("account")).rejects.toThrow(
      "Unreadable session column profile_dir.",
    );
    await expect(exists(outside)).resolves.toBeTruthy();
  });

  it("keeps xrio.db and its -wal and -shm files at mode 0600 after a session scrape", async () => {
    await using visited = await sessionClient();
    const { client, stateDir } = visited;

    await client.scrape({ format: "html", session: "account", url: PAGE });

    const modes = await Promise.all(
      ["xrio.db", "xrio.db-wal", "xrio.db-shm"].map(
        async (file) => await fileMode(path.join(stateDir, file)),
      ),
    );

    expect(modes).toStrictEqual([0o600, 0o600, 0o600]);
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
