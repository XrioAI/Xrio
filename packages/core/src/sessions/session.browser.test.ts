import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { XrioClient } from "../client.ts";
import { cloudflareCases } from "../testing/block-cases/cloudflare.ts";
import { chromePath } from "../testing/chrome-path.ts";
import { startFixtureServer } from "../testing/fixture-server.ts";
import type { FixtureHandler } from "../testing/fixture-server.ts";
import { leftovers, nothingLeft } from "../testing/leftovers.ts";
import { storedProfile } from "./profiles.ts";

const fixturePage: FixtureHandler = (request, response) => {
  const route = new URL(request.url ?? "/", "http://fixture").pathname;

  if (route === "/cached" || route === "/cached.js") {
    response.setHeader("cache-control", "public, max-age=3600");
    response.setHeader("content-type", route === "/cached" ? "text/html" : "text/javascript");
    response.end(
      route === "/cached" ? '<html><body><script src="/cached.js"></script></body></html>' : "",
    );

    return;
  }

  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");

  if (route === "/hang") {
    response.setHeader("set-cookie", "unrecorded=must-clear; Path=/; Max-Age=3600");
    response.write("<html><body>");

    return;
  }

  if (route === "/blocked") {
    response.statusCode = 403;
    response.setHeader("set-cookie", "challenge=kept; Path=/; Max-Age=3600");
    response.end(cloudflareCases.tp_cloudflare_1020_dom_only.html);

    return;
  }

  if (route === "/set") {
    response.setHeader("set-cookie", "persist=yes; Path=/; Max-Age=3600");
  }

  response.end(
    `<html><body><h1>Session fixture</h1><pre>${request.headers.cookie ?? "empty"}</pre></body></html>`,
  );
};

const cookieCount = (stateDir: string, name: string): number => {
  const profile = path.join(stateDir, storedProfile("local", "failed-first"));
  const database = new DatabaseSync(path.join(profile, "Default", "Cookies"), { readOnly: true });

  try {
    return Number(
      database.prepare("SELECT COUNT(*) AS count FROM cookies WHERE name = ?").get(name)?.count,
    );
  } finally {
    database.close();
  }
};

describe("persistent sessions through the public API", () => {
  it("returns with cookies and the frozen device after closing the first client", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "xrio-session-browser-"));
    const configFile = path.join(stateDir, "xrio.config.json");
    await writeFile(configFile, "{}");
    await using fixture = await startFixtureServer(fixturePage);
    const options = { browserPath: chromePath(), configFile, mode: "headless" as const, stateDir };

    try {
      await using firstClient = new XrioClient(options);

      const first = await firstClient.scrape({
        format: "html",
        session: "cookies",
        url: `${fixture.origin}/set`,
      });

      await firstClient.close();
      await using nextClient = new XrioClient(options);

      const second = await nextClient.scrape({
        format: "html",
        session: "cookies",
        url: `${fixture.origin}/read`,
      });

      expect(second.data).toContain("persist=yes");

      if (first.identity.mode === "http" || second.identity.mode === "http") {
        throw new Error("Browser session visits must produce browser identity records.");
      }

      expect(second.identity.record).toStrictEqual(first.identity.record);
      expect(second.session).toMatchObject({
        created: false,
        name: "cookies",
        visits: 2,
        warmth: "warm",
      });
      await nextClient.close();
      await expect(leftovers(stateDir)).resolves.toStrictEqual(nothingLeft);
    } finally {
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  it("reports the cacheDir where Chrome keeps the session's HTTP cache", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "xrio-session-browser-"));
    const configFile = path.join(stateDir, "xrio.config.json");
    await writeFile(configFile, "{}");
    await using fixture = await startFixtureServer(fixturePage);

    try {
      await using client = new XrioClient({
        browserPath: chromePath(),
        configFile,
        mode: "headless",
        stateDir,
      });

      const result = await client.scrape({
        format: "html",
        session: "cached",
        url: `${fixture.origin}/cached`,
      });

      await client.close();
      await expect(readdir(result.session?.cacheDir ?? stateDir)).resolves.toContain("Cache_Data");
    } finally {
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  it("keeps a blocked first visit's cookie together with its device record", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "xrio-session-browser-"));
    const configFile = path.join(stateDir, "xrio.config.json");
    await writeFile(configFile, "{}");
    await using fixture = await startFixtureServer(fixturePage);
    const options = { browserPath: chromePath(), configFile, mode: "headless" as const, stateDir };

    try {
      await using firstClient = new XrioClient(options);

      const first = await firstClient.scrape({
        format: "html",
        session: "blocked-first",
        timeoutMs: 20_000,
        url: `${fixture.origin}/blocked`,
      });

      expect(first).toMatchObject({
        block: { verdict: "blocked" },
        session: { visits: 1, warmth: "contacted" },
        status: 403,
      });
      await firstClient.close();
      await using nextClient = new XrioClient(options);

      const second = await nextClient.scrape({
        format: "html",
        session: "blocked-first",
        url: `${fixture.origin}/read`,
      });

      expect(second.data).toContain("challenge=kept");

      if (first.identity.mode === "http" || second.identity.mode === "http") {
        throw new Error("Browser session visits must produce browser identity records.");
      }

      expect(second.identity.record).toStrictEqual(first.identity.record);
      expect(second.session).toMatchObject({ visits: 2, warmth: "warm" });
      await nextClient.close();
      await expect(leftovers(stateDir)).resolves.toStrictEqual(nothingLeft);
    } finally {
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  it("stores no record after a failed first navigation and clears its cookie before reuse", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "xrio-session-browser-"));
    const configFile = path.join(stateDir, "xrio.config.json");
    await writeFile(configFile, "{}");
    await using fixture = await startFixtureServer(fixturePage);
    const options = { browserPath: chromePath(), configFile, mode: "headless" as const, stateDir };

    try {
      await using firstClient = new XrioClient(options);
      await expect(
        firstClient.scrape({
          format: "html",
          session: "failed-first",
          timeoutMs: 12_000,
          url: `${fixture.origin}/hang`,
        }),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      await firstClient.close();
      const database = new DatabaseSync(path.join(stateDir, "xrio.db"), { readOnly: true });

      try {
        expect(
          database
            .prepare("SELECT record, visits FROM sessions WHERE tenant = 'local' AND name = ?")
            .get("failed-first"),
        ).toMatchObject({ record: null, visits: 0 });
      } finally {
        database.close();
      }

      expect(cookieCount(stateDir, "unrecorded")).toBe(1);
      await using nextClient = new XrioClient(options);

      const second = await nextClient.scrape({
        format: "html",
        session: "failed-first",
        url: `${fixture.origin}/read`,
      });

      await nextClient.close();
      expect({
        cookieCount: cookieCount(stateDir, "unrecorded"),
        empty: second.data.includes("<pre>empty</pre>"),
      }).toStrictEqual({ cookieCount: 0, empty: true });
      await expect(leftovers(stateDir)).resolves.toStrictEqual(nothingLeft);
    } finally {
      await rm(stateDir, { force: true, recursive: true });
    }
  });
});
