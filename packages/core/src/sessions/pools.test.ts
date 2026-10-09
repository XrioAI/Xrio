import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import type { HostCapabilities } from "../humanizer/contracts.ts";
import type { ProfileUse } from "../sources/browser/browser-process.ts";
import type { SiteVisit } from "../sources/visit.ts";
import { attemptLog } from "../testing/attempt-log.ts";
import { choosePoolMember } from "./pools.ts";
import { createSessions } from "./session.ts";
import { SessionStore } from "./store.ts";
import type { SessionRow } from "./store.ts";

const member = (
  name: string,
  lastVisitAt: number,
  state: SessionRow["state"] = "ready",
): SessionRow => ({
  binding: { kind: "unbound", stickyId: "sticky" },
  browserArgs: undefined,
  chromeMajor: 154,
  coolingStreak: 0,
  createdAt: 0,
  epoch: 0,
  expiresAt: 0,
  holder: undefined,
  lastVisitAt,
  name,
  platform: undefined,
  pool: "catalog",
  profileDir: "profiles/0123456789abcdef",
  proxyUrl: undefined,
  record: undefined,
  state,
  visits: 0,
});

const pool = { kind: "pool", name: "catalog", site: "example.com", size: 2 } as const;

const seed = () => "9f2c41d07a3be815";

const host = (chromeMajor: number): HostCapabilities => ({
  chromeMajor,
  permittedCpus: 8,
  platform: "linux",
});

const pooledSessions = async (profileUse: () => ProfileUse = () => "clear") => {
  const root = await mkdtemp(path.join(tmpdir(), "xrio-pool-"));

  const sessions = createSessions(root, {
    profileUse: async () => await Promise.resolve(profileUse()),
    wallNow: () => 1_000_000,
  });

  return {
    [Symbol.asyncDispose]: async () => {
      await sessions.close();
      await rm(root, { force: true, recursive: true });
    },
    root,
    sessions,
  };
};

const memberPaths = (root: string, hash: string) => ({
  cacheDir: path.join(root, "profiles", hash, "Default", "Cache"),
  profileDir: path.join(root, "profiles", hash),
});

const chooseCold = (members: readonly SessionRow[]) => choosePoolMember(members, () => "cold");

describe("pools", () => {
  it("chooses a warm free member before a colder member used less recently", () => {
    const members = [member("catalog/1", 100), member("catalog/2", 200)];
    expect(
      choosePoolMember(members, (name) => (name === "catalog/2" ? "warm" : "cold"))?.name,
    ).toBe("catalog/2");
    expect(choosePoolMember(members, () => "cold")?.name).toBe("catalog/1");
  });

  it("excludes held, quarantined and retired members even when warm", () => {
    const held = {
      ...member("catalog/1", 1),
      holder: { host: "host", pid: 1, start: "start", token: "held" },
    };

    const members = [
      held,
      member("catalog/2", 2, "quarantined"),
      member("catalog/3", 3, "retired"),
      member("catalog/4", 4),
    ];

    expect(choosePoolMember(members, () => "warm")?.name).toBe("catalog/4");
    expect(choosePoolMember(members.slice(0, 3), () => "warm")).toBeUndefined();
  });

  const claimRequest = {
    check: () => {},
    dead: new Set<string>(),
    grace: 5000,
    holder: { host: "test", pid: process.pid, start: "start", token: "owner" },
    length: 60_000,
    major: 154,
    now: 100,
    stickyId: randomUUID,
  };

  const served: SiteVisit = {
    challengeOutcome: null,
    challengeRules: [],
    deviceDigest: "device",
    exitAddress: null,
    site: "example.com",
    vendor: null,
    verdict: "ok",
  };

  it.each([
    { name: "catalog/1", retiredState: "retired" },
    { name: "account", retiredState: "ready" },
  ])(
    "retires $name only when it is a pool member after three cooling outcomes",
    async ({ name, retiredState }) => {
      const root = await mkdtemp(path.join(tmpdir(), "xrio-pool-"));
      const store = new SessionStore(root);
      using deadline = startDeadline(10_000);
      const owner = { epoch: 1, name, token: "owner" };

      const finish = {
        attempt: attemptLog(),
        exited: true,
        major: 154,
        maxAgeMs: 1000,
        now: 101,
      };

      const blocked = { ...finish, siteVisit: { ...served, verdict: "blocked" as const } };

      try {
        const claim =
          name === "account"
            ? await store.claimSession(name, claimRequest, deadline)
            : await store.claimPool(
                { name: "catalog", size: 1 },
                claimRequest,
                chooseCold,
                deadline,
              );

        expect(claim?.row.name).toBe(name);
        await store.finishVisit(owner, blocked, deadline);
        expect(store.read(name)?.coolingStreak).toBe(0);
        await store.finishVisit(owner, { ...finish, siteVisit: served }, deadline);
        await store.finishVisit(owner, blocked, deadline);
        expect(store.read(name)).toMatchObject({ coolingStreak: 1, state: "ready" });
        await store.finishVisit(owner, blocked, deadline);
        expect(store.read(name)).toMatchObject({ coolingStreak: 2, state: "ready" });
        await store.finishVisit(owner, blocked, deadline);
        expect(store.read(name)).toMatchObject({ coolingStreak: 3, state: retiredState });
        await store.releaseSession(owner, deadline);
      } finally {
        store.close();
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it("a served visit breaks a cooling streak", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-pool-"));
    const store = new SessionStore(root);
    using deadline = startDeadline(10_000);
    const owner = { epoch: 1, name: "catalog/1", token: "owner" };

    try {
      await store.claimPool({ name: "catalog", size: 1 }, claimRequest, chooseCold, deadline);

      const finish = {
        attempt: attemptLog(),
        exited: true,
        major: 154,
        maxAgeMs: 1000,
        now: 110,
      };

      const blocked = { ...finish, siteVisit: { ...served, verdict: "blocked" as const } };
      await store.finishVisit(owner, { ...finish, siteVisit: served }, deadline);
      await store.finishVisit(owner, blocked, deadline);
      await store.finishVisit(owner, blocked, deadline);
      await store.finishVisit(owner, { ...finish, siteVisit: served }, deadline);
      await store.finishVisit(owner, blocked, deadline);

      expect(store.read(owner.name)?.coolingStreak).toBe(1);
      expect(store.read(owner.name)?.state).toBe("ready");
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("claims pool capacity atomically across separate store connections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-pool-"));
    const first = new SessionStore(root);
    const second = new SessionStore(root);
    using deadline = startDeadline(10_000);

    try {
      const claims = await Promise.all([
        first.claimPool({ name: "catalog", size: 1 }, claimRequest, chooseCold, deadline),
        second.claimPool(
          { name: "catalog", size: 1 },
          { ...claimRequest, holder: { ...claimRequest.holder, token: "second" } },
          chooseCold,
          deadline,
        ),
      ]);

      expect(claims.map((claim) => claim?.row.name ?? null)).toStrictEqual(["catalog/1", null]);
      expect(first.list().map((row) => row.name)).toStrictEqual(["catalog/1"]);
    } finally {
      first.close();
      second.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("replaces a retired member without reusing its number or profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-pool-"));
    const store = new SessionStore(root);
    using deadline = startDeadline(10_000);
    const owner = { epoch: 1, name: "catalog/1", token: "owner" };

    try {
      const original = await store.claimPool(
        { name: "catalog", size: 1 },
        claimRequest,
        chooseCold,
        deadline,
      );

      expect(original?.row.name).toBe("catalog/1");
      await store.sessionState(owner, "retired", deadline);
      await store.releaseSession(owner, deadline);

      const replacement = await store.claimPool(
        { name: "catalog", size: 1 },
        claimRequest,
        chooseCold,
        deadline,
      );

      expect(replacement?.row.name).toBe("catalog/2");
      expect(store.read("catalog/2")?.state).toBe("ready");
    } finally {
      store.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("serves a claim from another member when one member cannot be presented", async () => {
    await using pooled = await pooledSessions();
    const { root, sessions } = pooled;
    using deadline = startDeadline(10_000);

    {
      await using newer = await sessions.hold(pool, { capabilities: host(155), seed }, deadline);
      await newer.finish({
        browserArgs: [],
        ...attemptLog(),
        closed: { exited: true },
        record: null,
        siteVisit: served,
      });
    }

    await using older = await sessions.hold(pool, { capabilities: host(154), seed }, deadline);

    expect(older.summary(served, { browserArgs: [], proxy: undefined })).toStrictEqual({
      ...memberPaths(root, "9868bc4147116d6f"),
      created: true,
      name: "catalog/2",
      pool: "catalog",
      visits: 1,
      warmth: "warm",
    });
    await expect(sessions.admin.list()).resolves.toStrictEqual([
      {
        ...memberPaths(root, "c92e5a3717c6ad81"),
        lastVisitAt: 1_000_000,
        name: "catalog/1",
        outcomes: { blocked: 0, failed: 0, ok: 1, queued: 0, suspect: 0, unknown: 0 },
        pool: "catalog",
        state: "ready",
        visits: 1,
      },
      {
        ...memberPaths(root, "9868bc4147116d6f"),
        lastVisitAt: 1_000_000,
        name: "catalog/2",
        outcomes: { blocked: 0, failed: 0, ok: 0, queued: 0, suspect: 0, unknown: 0 },
        pool: "catalog",
        state: "ready",
        visits: 0,
      },
    ]);
  });

  it("fails a full pool of members it cannot present with the first refusal", async () => {
    await using pooled = await pooledSessions();
    const { sessions } = pooled;
    using deadline = startDeadline(10_000);
    const single = { ...pool, size: 1 };

    {
      await using newer = await sessions.hold(single, { capabilities: host(155), seed }, deadline);
      await newer.finish({
        browserArgs: [],
        ...attemptLog(),
        closed: { exited: true },
        record: null,
        siteVisit: served,
      });
    }

    await expect(
      sessions.hold(single, { capabilities: host(154), seed }, deadline),
    ).rejects.toMatchObject({
      code: "SESSION_UNAVAILABLE",
      details: { reason: "browser-too-old" },
    });
    await expect(sessions.admin.list()).resolves.toMatchObject([
      { name: "catalog/1", state: "ready" },
    ]);
  });

  it("leaves a member ready and fails when the process table cannot be read", async () => {
    let use: ProfileUse = "clear";
    await using pooled = await pooledSessions(() => use);
    const { root, sessions } = pooled;
    using deadline = startDeadline(10_000);

    {
      await using first = await sessions.hold(pool, { capabilities: host(154), seed }, deadline);
      expect(first.profile.kind).toBe("persistent");
    }

    use = "unknown";

    await expect(
      sessions.hold(pool, { capabilities: host(154), seed }, deadline),
    ).rejects.toMatchObject({
      code: "SESSION_UNAVAILABLE",
      details: { reason: "process-table-unreadable" },
    });
    await expect(sessions.admin.list()).resolves.toStrictEqual([
      {
        ...memberPaths(root, "c92e5a3717c6ad81"),
        lastVisitAt: 1_000_000,
        name: "catalog/1",
        outcomes: { blocked: 0, failed: 0, ok: 0, queued: 0, suspect: 0, unknown: 0 },
        pool: "catalog",
        state: "ready",
        visits: 0,
      },
    ]);
  });
});
