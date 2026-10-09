import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { SessionStore } from "./store.ts";

describe("session ownership", () => {
  it("rejects stale writes after takeover on a real SQLite store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-store-"));
    const db = new SessionStore(root);
    using deadline = startDeadline(10_000);
    const holder = { host: "host", pid: 1, start: "started", token: "first" };

    const request = {
      check: () => true,
      dead: new Set<string>(),
      grace: 5000,
      holder,
      length: 60_000,
      major: 154,
      now: 1000,
    };

    try {
      const first = await db.claimSession("account", request, deadline);

      const waiting = await db.claimSession(
        "account",
        { ...request, holder: { ...holder, token: "second" }, now: 2000 },
        deadline,
      );

      const stale = { epoch: 1, name: "account", token: "first" };
      const renewed = await db.renewOwnership(stale, 62_000, deadline);

      const next = await db.claimSession(
        "account",
        { ...request, holder: { ...holder, token: "second" }, major: 155, now: 67_001 },
        deadline,
      );

      expect({
        created: first?.created,
        epoch: next?.row.epoch,
        major: first?.row.chromeMajor,
        renewed,
        state: next?.row.state,
        waiting,
      }).toStrictEqual({
        created: true,
        epoch: 2,
        major: 154,
        renewed: true,
        state: "quarantined",
        waiting: undefined,
      });
      const finish = { exited: true, major: 155, maxAgeMs: 1_800_000, now: 68_000 };
      const renewal = await db.renewOwnership(stale, 90_000, deadline);
      const written = await db.finishVisit(stale, finish, deadline);
      const released = await db.releaseSession(stale, deadline);
      expect({ released, renewal, written }).toStrictEqual({
        released: false,
        renewal: false,
        written: false,
      });
      const owner = { epoch: 2, name: "account", token: "second" };
      await db.finishVisit(owner, { ...finish, exited: false }, deadline);
      await db.releaseSession(owner, deadline);
      expect({
        holder: db.read("account")?.holder,
        state: db.read("account")?.state,
      }).toStrictEqual({ holder: undefined, state: "quarantined" });
    } finally {
      db.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
