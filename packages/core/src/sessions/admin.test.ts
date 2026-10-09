import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "../client.ts";
import { fakeChromePath } from "../testing/fake-chrome-path.ts";

const PAGE = "https://fake.test/page";

const sessionClient = async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "xrio-sessions-"));
  const configFile = path.join(stateDir, "xrio.config.json");
  await writeFile(configFile, "{}");

  const client = new XrioClient({
    browserPath: await fakeChromePath("normal"),
    configFile,
    mode: "headless",
    stateDir,
  });

  return {
    [Symbol.asyncDispose]: async () => {
      await client.close();
      await rm(stateDir, { force: true, recursive: true });
    },
    client,
    stateDir,
  };
};

const visitsOf = (stateDir: string, name: string) => {
  const database = new DatabaseSync(path.join(stateDir, "xrio.db"), { readOnly: true });

  try {
    return database.prepare("SELECT visits FROM sessions WHERE name = ?").get(name)?.visits;
  } finally {
    database.close();
  }
};

describe("sessions through the public client", () => {
  it.each([
    { reason: "browser-too-old", stored: "chrome_major=9999" },
    { reason: "cannot-present", stored: "platform='plan9'" },
    { reason: "record-refused", stored: "record='{'" },
  ])("refuses a session scrape with $reason when it stored $stored", async ({ reason, stored }) => {
    await using visited = await sessionClient();
    const { client, stateDir } = visited;

    await client.scrape({ format: "html", session: "account", url: PAGE });
    await expect.poll(() => visitsOf(stateDir, "account")).toBe(1);

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
});
