import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "../client.ts";
import type { ClientOptions, SessionVisit } from "../client.ts";
import { fakeChromePath } from "../testing/fake-chrome-path.ts";
import { closedLoopbackPort } from "../testing/fixture-server.ts";

const PAGE = "https://fake.test/page";

const SCRATCH_PATH = /\/tmp\/xrio-\d+\/b[^/]+/gu;

const sharedStateDir = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xrio-visits-"));
  const stateDir = path.join(root, "state");
  const configFile = path.join(root, "xrio.config.json");
  const clients: XrioClient[] = [];
  await writeFile(configFile, "{}");

  const unchangingChrome = async (scenario: string): Promise<string> => {
    const browserPath = path.join(root, `chrome-${scenario}`);

    await copyFile(await fakeChromePath(scenario), browserPath);
    await chmod(browserPath, 0o755);

    return browserPath;
  };

  const client = async (scenario = "normal", options: Pick<ClientOptions, "proxy"> = {}) => {
    const created = new XrioClient({
      ...options,
      browserPath: await unchangingChrome(scenario),
      cacheDir: path.join(root, "cache"),
      configFile,
      mode: "headless",
      stateDir,
    });

    clients.push(created);

    return created;
  };

  return {
    [Symbol.asyncDispose]: async () => {
      await Promise.all(
        clients.map(async (created) => {
          await created.close();
        }),
      );
      await rm(root, { force: true, recursive: true });
    },
    client,
    stateDir,
  };
};

const loggedVisits = async (client: XrioClient, count: number): Promise<SessionVisit[]> => {
  await expect
    .poll(async () => {
      const logged = await client.sessions.visits("account");

      return logged.length;
    })
    .toBe(count);

  return await client.sessions.visits("account");
};

const withoutScratch = (argv: readonly string[] | null): string[] =>
  (argv ?? []).map((arg) => arg.replaceAll(SCRATCH_PATH, "<scratch>"));

describe("a session's visit log", () => {
  it("logs a blocked, an ok and a failed visit and counts their outcomes", async () => {
    await using shared = await sharedStateDir();
    const served = await shared.client();
    const blocked = await shared.client("blocked");
    const failing = await shared.client("navigate-error");

    await served.scrape({ format: "html", session: "account", url: PAGE });
    await blocked.scrape({ format: "html", session: "account", url: PAGE });
    await expect(
      failing.scrape({ format: "html", session: "account", url: PAGE }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });

    const logged = await loggedVisits(served, 3);
    const [listed] = await served.sessions.list();

    expect({
      logged: logged.map(({ errorCode, outcome, site, status, url, vendor }) => ({
        errorCode,
        outcome,
        site,
        status,
        url,
        vendor,
      })),
      outcomes: listed?.outcomes,
    }).toStrictEqual({
      logged: [
        {
          errorCode: "NETWORK_ERROR",
          outcome: "failed",
          site: "fake.test",
          status: null,
          url: PAGE,
          vendor: null,
        },
        {
          errorCode: null,
          outcome: "blocked",
          site: "fake.test",
          status: 403,
          url: PAGE,
          vendor: "cloudflare",
        },
        { errorCode: null, outcome: "ok", site: "fake.test", status: 200, url: PAGE, vendor: null },
      ],
      outcomes: { blocked: 1, failed: 1, ok: 1, queued: 0, suspect: 0, unknown: 0 },
    });
  });

  it("filters the log by site, limits it, and validates the call like the other admin calls", async () => {
    await using shared = await sharedStateDir();
    const client = await shared.client();

    for (const url of [PAGE, "https://other.test/page", `${PAGE}?again`]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One session serves its scrapes in order.
      await client.scrape({ format: "html", session: "account", url });
    }

    await loggedVisits(client, 3);

    const urls = async (filter: Parameters<XrioClient["sessions"]["visits"]>[1]) => {
      const logged = await client.sessions.visits("account", filter);

      return logged.map(({ url }) => url);
    };

    expect({
      first: await urls({ limit: 1 }),
      missing: await client.sessions.visits("never-made"),
      other: await urls({ limit: 5, site: "other.test" }),
      site: await urls({ site: "fake.test" }),
    }).toStrictEqual({
      first: [`${PAGE}?again`],
      missing: [],
      other: ["https://other.test/page"],
      site: [`${PAGE}?again`, PAGE],
    });
    await expect(client.sessions.visits("")).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(client.sessions.visits("account", { site: "" })).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    await expect(client.sessions.visits("account", { limit: 0 })).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
  });

  it("keeps argv that differ only in per-launch paths and one plan digest across replays", async () => {
    await using shared = await sharedStateDir();
    const client = await shared.client();

    for (const url of [PAGE, PAGE, PAGE]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One session serves its scrapes in order.
      await client.scrape({ format: "html", session: "account", url });
    }

    const [newest, replayed] = await loggedVisits(client, 3);
    const [listed] = await client.sessions.list();

    expect({
      argvDiffer: JSON.stringify(newest?.argv) !== JSON.stringify(replayed?.argv),
      digestOfPlan: createHash("sha256")
        .update(newest?.plan ?? "")
        .digest("hex"),
      planDigest: replayed?.planDigest,
      profile: newest?.argv?.includes(`--user-data-dir=${listed?.profileDir}`),
      withoutScratch: withoutScratch(newest?.argv ?? null),
    }).toStrictEqual({
      argvDiffer: true,
      digestOfPlan: newest?.planDigest,
      planDigest: newest?.planDigest,
      profile: true,
      withoutScratch: withoutScratch(replayed?.argv ?? null),
    });
    expect(newest?.planDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("logs a start failure that never launched Chrome", async () => {
    await using shared = await sharedStateDir();
    const port = await closedLoopbackPort();

    const client = await shared.client("normal", {
      proxy: `http://user-1:secret@127.0.0.1:${port}`,
    });

    await expect(
      client.scrape({ format: "html", session: "account", url: PAGE }),
    ).rejects.toMatchObject({ code: "PROXY_UNREACHABLE" });

    const [failed] = await loggedVisits(client, 1);

    expect(failed).toMatchObject({
      argv: null,
      errorCode: "PROXY_UNREACHABLE",
      outcome: "failed",
      plan: null,
      planDigest: null,
      url: PAGE,
    });
  });

  it("deletes a session's log with the session", async () => {
    await using shared = await sharedStateDir();
    const client = await shared.client();

    await client.scrape({ format: "html", session: "account", url: PAGE });
    await client.scrape({ format: "html", session: "account", url: PAGE });
    await loggedVisits(client, 2);
    await client.sessions.delete("account");
    await client.scrape({ format: "html", session: "account", url: `${PAGE}?after` });
    await loggedVisits(client, 1);

    const database = new DatabaseSync(path.join(shared.stateDir, "xrio.db"), { readOnly: true });

    try {
      expect(
        database
          .prepare("SELECT url FROM visits")
          .all()
          .map((row) => ({ ...row })),
      ).toStrictEqual([{ url: `${PAGE}?after` }]);
    } finally {
      database.close();
    }
  });
});
