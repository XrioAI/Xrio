import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "../deadline.ts";
import { resolveClientOptions, resolveScrapeIntent } from "../options.ts";
import { createSessions } from "./session.ts";

const { session } = resolveScrapeIntent(
  { format: "html", session: "account", url: "https://example.com" },
  resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
);

const claimChecks = {
  capabilities: { chromeMajor: 154, permittedCpus: 32, platform: "linux" },
  seed: () => "9f2c41d07a3be815",
} as const;

const exists = async (file: string): Promise<boolean> => {
  try {
    await lstat(file);

    return true;
  } catch {
    return false;
  }
};

describe("the session database directory", () => {
  it("holds xrio.db while stateDir holds the profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "xrio-database-dir-"));
    const stateDir = path.join(root, "state");
    const databaseDir = path.join(root, "database");

    const sessions = createSessions(stateDir, {
      databaseDir,
      profileUse: async () => await Promise.resolve("clear" as const),
    });

    try {
      using deadline = startDeadline(10_000);
      const hold = await sessions.hold(session, claimChecks, deadline);
      await hold[Symbol.asyncDispose]();

      expect({
        database: await exists(path.join(databaseDir, "xrio.db")),
        databaseInStateDir: await exists(path.join(stateDir, "xrio.db")),
        profile: await exists(path.join(stateDir, "profiles", "34b999a96c2c821a")),
      }).toStrictEqual({ database: true, databaseInStateDir: false, profile: true });
    } finally {
      await sessions.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
