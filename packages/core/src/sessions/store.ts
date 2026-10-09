/* oxlint-disable anti-slop/no-runtime-typeof -- SQLite rows are parsed into session rows here. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import { untilDeadline } from "../deadline.ts";
import type { Deadline } from "../deadline.ts";
import type { SiteVisit } from "../sources/visit.ts";
import { LOCAL_TENANT } from "./profiles.ts";
import type { Holder } from "./profiles.ts";
import { warmthAfter, warmthAt } from "./warmth.ts";
import type { SiteWarmth } from "./warmth.ts";

export type SessionState = "ready" | "quarantined";

export interface SessionRow {
  readonly name: string;
  readonly state: SessionState;
  readonly epoch: number;
  readonly holder: Holder | undefined;
  readonly expiresAt: number;
  readonly chromeMajor: number;
  readonly record: string | undefined;
  readonly platform: string | undefined;
  readonly browserArgs: readonly string[] | undefined;
  readonly visits: number;
  readonly createdAt: number;
  readonly lastVisitAt: number;
}

export interface Ownership {
  readonly name: string;
  readonly epoch: number;
  readonly token: string;
}

export interface Claim {
  readonly row: SessionRow;
  readonly created: boolean;
}

export interface Takeover {
  readonly holder: Holder;
  readonly now: number;
  readonly length: number;
  readonly grace: number;
  readonly dead: ReadonlySet<string>;
}

export interface ClaimRequest extends Takeover {
  readonly major: number;
  readonly check: (row: SessionRow) => void;
}

export type RemovalClaim =
  | { readonly kind: "claimed"; readonly claim: Claim }
  | { readonly kind: "held" }
  | { readonly kind: "skipped" };

export interface FinishRequest {
  readonly major: number;
  readonly exited: boolean;
  readonly record?: {
    readonly json: string;
    readonly platform: string;
    readonly browserArgs: readonly string[];
  };
  readonly siteVisit?: SiteVisit;
  readonly now: number;
  readonly maxAgeMs: number;
}

const SCHEMA_VERSION = 1;

const POLL_INTERVAL_MS = 50;

const SQLITE_BUSY = 5;

const SQLITE_LOCKED = 6;

export const waitForTurn = async (
  deadline: Deadline,
  delayMs = POLL_INTERVAL_MS,
): Promise<void> => {
  const waiting = Promise.withResolvers<null>();

  const wake = () => {
    waiting.resolve(null);
  };

  const cancel = deadline.clock.setTimer(delayMs, wake);
  deadline.signal.addEventListener("abort", wake, { once: true });

  try {
    await untilDeadline(async () => {
      await waiting.promise;
    }, deadline);
  } finally {
    cancel();
    deadline.signal.removeEventListener("abort", wake);
  }
};

const storeIsBusy = (cause: unknown): boolean =>
  cause instanceof Error &&
  "errcode" in cause &&
  (cause.errcode === SQLITE_BUSY || cause.errcode === SQLITE_LOCKED);

type SqlRow = Record<string, SQLOutputValue>;

const textAt = (row: SqlRow, key: string): string => {
  const value = row[key];

  if (typeof value !== "string") {
    throw new TypeError(`Unreadable session column ${key}.`);
  }

  return value;
};

const optionalTextAt = (row: SqlRow, key: string): string | undefined => {
  const value = row[key];

  if (value === null) {
    return undefined;
  }

  return textAt(row, key);
};

const numberAt = (row: SqlRow, key: string): number => {
  const value = row[key];

  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`Unreadable session column ${key}.`);
  }

  return value;
};

const holderOf = (row: SqlRow): Holder | undefined =>
  row.holder_token === null
    ? undefined
    : {
        host: textAt(row, "holder_host"),
        pid: numberAt(row, "holder_pid"),
        start: textAt(row, "holder_start"),
        token: textAt(row, "holder_token"),
      };

const isText = (value: unknown): value is string => typeof value === "string";

const browserArgsOf = (row: SqlRow): readonly string[] | undefined => {
  const stored = optionalTextAt(row, "browser_args");

  if (stored === undefined) {
    return undefined;
  }

  const browserArgs: unknown = JSON.parse(stored);

  if (!Array.isArray(browserArgs) || !browserArgs.every(isText)) {
    throw new TypeError("Unreadable session column browser_args.");
  }

  return browserArgs;
};

const rowOf = (row: SqlRow): SessionRow => {
  const state = textAt(row, "state");

  if (state !== "ready" && state !== "quarantined") {
    throw new Error("Unreadable session state.");
  }

  return {
    browserArgs: browserArgsOf(row),
    chromeMajor: numberAt(row, "chrome_major"),
    createdAt: numberAt(row, "created_at"),
    epoch: numberAt(row, "epoch"),
    expiresAt: numberAt(row, "expires_at"),
    holder: holderOf(row),
    lastVisitAt: numberAt(row, "last_visit_at"),
    name: textAt(row, "name"),
    platform: optionalTextAt(row, "platform"),
    record: optionalTextAt(row, "record"),
    state,
    visits: numberAt(row, "visits"),
  };
};

const SCHEMA = `CREATE TABLE sessions(tenant TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'ready',
  epoch INTEGER NOT NULL DEFAULT 0,holder_host TEXT,holder_pid INTEGER,holder_start TEXT,holder_token TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,record TEXT,platform TEXT,browser_args TEXT,chrome_major INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
  last_visit_at INTEGER NOT NULL,PRIMARY KEY(tenant,name));
CREATE TABLE warmth(tenant TEXT NOT NULL,name TEXT NOT NULL,site TEXT NOT NULL,state TEXT NOT NULL,
  last_visit_at INTEGER NOT NULL,changed_at INTEGER NOT NULL,verdict TEXT NOT NULL,vendor TEXT,challenge_outcome TEXT,
  challenge_rules TEXT NOT NULL,exit_address TEXT,device_digest TEXT NOT NULL,PRIMARY KEY(tenant,name,site),
  FOREIGN KEY(tenant,name) REFERENCES sessions(tenant,name) ON DELETE CASCADE);`;

const migrate = (db: DatabaseSync): void => {
  db.exec("BEGIN IMMEDIATE");

  try {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;

    if (version === 0) {
      db.exec(`${SCHEMA} PRAGMA user_version=${SCHEMA_VERSION};`);
    } else if (version !== SCHEMA_VERSION) {
      throw new Error("Unsupported session store schema.");
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};

const isFree = (row: SessionRow, takeover: Takeover): boolean =>
  row.holder === undefined ||
  takeover.dead.has(row.holder.token) ||
  takeover.now > row.expiresAt + takeover.grace;

export class SessionStore {
  readonly #db: DatabaseSync;
  readonly #tenant: string;
  constructor(root: string, tenant = LOCAL_TENANT) {
    this.#tenant = tenant;
    this.#db = new DatabaseSync(path.join(root, "xrio.db"));

    try {
      this.#db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      migrate(this.#db);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }
  close(): void {
    this.#db.close();
  }
  list(): SessionRow[] {
    return this.#db
      .prepare("SELECT * FROM sessions WHERE tenant=? ORDER BY name")
      .all(this.#tenant)
      .map(rowOf);
  }
  read(name: string): SessionRow | undefined {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE tenant=? AND name=?")
      .get(this.#tenant, name);

    return row === undefined ? undefined : rowOf(row);
  }
  async #transaction<Result>(
    deadline: Deadline,
    run: () => Result,
    restore?: () => void,
  ): Promise<Result> {
    for (;;) {
      deadline.throwIfExpired();
      let begun = false;

      try {
        this.#db.exec("BEGIN IMMEDIATE");
        begun = true;
        const result = run();
        this.#db.exec("COMMIT");

        return result;
      } catch (error) {
        if (begun) {
          try {
            restore?.();
          } finally {
            this.#db.exec("ROLLBACK");
          }
        }

        if (!storeIsBusy(error)) {
          throw error;
        }

        // oxlint-disable-next-line eslint/no-await-in-loop -- A busy store is retried only after the current attempt has rolled back.
        await waitForTurn(deadline);
      }
    }
  }
  async exclusively<Result>(run: () => Result, deadline: Deadline): Promise<Result> {
    return await this.#transaction(deadline, run);
  }
  #claimed(name: string): SessionRow {
    const row = this.read(name);

    if (row === undefined) {
      throw new Error("The claimed session disappeared.");
    }

    return row;
  }
  #take(row: SessionRow, takeover: Takeover, major: number, created: boolean): Claim | undefined {
    if (!isFree(row, takeover)) {
      return undefined;
    }

    this.#db
      .prepare(`UPDATE sessions SET epoch=epoch+1,holder_host=?,holder_pid=?,holder_start=?,holder_token=?,expires_at=?,chrome_major=MAX(chrome_major,?),
      state=CASE WHEN holder_token IS NOT NULL THEN 'quarantined' ELSE state END WHERE tenant=? AND name=?`)
      .run(
        takeover.holder.host,
        takeover.holder.pid,
        takeover.holder.start,
        takeover.holder.token,
        takeover.now + takeover.length,
        major,
        this.#tenant,
        row.name,
      );

    return { created, row: this.#claimed(row.name) };
  }
  #inserted(name: string, request: ClaimRequest): SessionRow {
    this.#db
      .prepare("INSERT INTO sessions(tenant,name,created_at,last_visit_at) VALUES(?,?,?,?)")
      .run(this.#tenant, name, request.now, request.now);

    return this.#claimed(name);
  }
  async claimSession(
    name: string,
    request: ClaimRequest,
    deadline: Deadline,
  ): Promise<Claim | undefined> {
    return await this.#transaction(deadline, () => {
      const known = this.read(name);

      if (known === undefined) {
        return this.#take(this.#inserted(name, request), request, request.major, true);
      }

      request.check(known);

      return this.#take(known, request, request.major, false);
    });
  }
  async claimForRemoval(
    name: string,
    takeover: Takeover,
    eligible: (row: SessionRow) => boolean,
    deadline: Deadline,
  ): Promise<RemovalClaim> {
    return await this.#transaction(deadline, (): RemovalClaim => {
      const known = this.read(name);

      if (known === undefined || !eligible(known)) {
        return { kind: "skipped" };
      }

      const claim = this.#take(known, takeover, 0, false);

      return claim === undefined ? { kind: "held" } : { claim, kind: "claimed" };
    });
  }
  async renewOwnership(owner: Ownership, expiresAt: number, deadline: Deadline): Promise<boolean> {
    return await this.#transaction(
      deadline,
      () =>
        this.#db
          .prepare(
            "UPDATE sessions SET expires_at=? WHERE tenant=? AND name=? AND epoch=? AND holder_token=?",
          )
          .run(expiresAt, this.#tenant, owner.name, owner.epoch, owner.token).changes === 1,
    );
  }
  async sessionState(owner: Ownership, state: SessionState, deadline: Deadline): Promise<boolean> {
    return await this.#transaction(
      deadline,
      () =>
        this.#db
          .prepare(
            "UPDATE sessions SET state=? WHERE tenant=? AND name=? AND epoch=? AND holder_token=?",
          )
          .run(state, this.#tenant, owner.name, owner.epoch, owner.token).changes === 1,
    );
  }
  #saveSiteVisit(owner: Ownership, request: FinishRequest, visit: SiteVisit): void {
    const before = warmthAt(this.siteWarmth(owner.name, visit.site), request.now, request.maxAgeMs);
    const state = warmthAfter(before, visit.verdict);

    this.#db
      .prepare(`INSERT INTO warmth(tenant,name,site,state,last_visit_at,changed_at,verdict,vendor,challenge_outcome,challenge_rules,exit_address,device_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant,name,site) DO UPDATE SET state=excluded.state,last_visit_at=excluded.last_visit_at,changed_at=CASE WHEN warmth.state=excluded.state THEN warmth.changed_at ELSE excluded.changed_at END,
      verdict=excluded.verdict,vendor=excluded.vendor,challenge_outcome=excluded.challenge_outcome,challenge_rules=excluded.challenge_rules,exit_address=excluded.exit_address,device_digest=excluded.device_digest`)
      .run(
        this.#tenant,
        owner.name,
        visit.site,
        state,
        request.now,
        request.now,
        visit.verdict,
        visit.vendor,
        visit.challengeOutcome,
        JSON.stringify(visit.challengeRules),
        visit.exitAddress,
        visit.deviceDigest,
      );
  }
  async finishVisit(
    owner: Ownership,
    request: FinishRequest,
    deadline: Deadline,
  ): Promise<boolean> {
    return await this.#transaction(deadline, () => {
      const visited = request.siteVisit === undefined ? 0 : 1;

      const updated =
        this.#db
          .prepare(
            "UPDATE sessions SET chrome_major=MAX(chrome_major,?),state=?,record=COALESCE(record,?),platform=COALESCE(platform,?),browser_args=COALESCE(browser_args,?),visits=visits+?,last_visit_at=CASE WHEN ? THEN ? ELSE last_visit_at END WHERE tenant=? AND name=? AND epoch=? AND holder_token=?",
          )
          .run(
            request.major,
            request.exited ? "ready" : "quarantined",
            request.record?.json ?? null,
            request.record?.platform ?? null,
            request.record === undefined ? null : JSON.stringify(request.record.browserArgs),
            visited,
            visited,
            request.now,
            this.#tenant,
            owner.name,
            owner.epoch,
            owner.token,
          ).changes === 1;

      if (!updated) {
        return false;
      }

      if (request.siteVisit !== undefined) {
        this.#saveSiteVisit(owner, request, request.siteVisit);
      }

      return true;
    });
  }
  siteWarmth(name: string, site: string): SiteWarmth | undefined {
    const row = this.#db
      .prepare("SELECT state,last_visit_at FROM warmth WHERE tenant=? AND name=? AND site=?")
      .get(this.#tenant, name, site);

    if (row === undefined) {
      return undefined;
    }

    if (
      row.state !== "cold" &&
      row.state !== "contacted" &&
      row.state !== "warm" &&
      row.state !== "cooling"
    ) {
      throw new Error("Unreadable warmth row.");
    }

    return { lastVisitAt: numberAt(row, "last_visit_at"), state: row.state };
  }
  async deleteSession(
    owner: Ownership,
    deadline: Deadline,
    remove?: () => void,
    restore?: () => void,
  ): Promise<boolean> {
    return await this.#transaction(
      deadline,
      () => {
        const row = this.read(owner.name);

        if (row?.epoch !== owner.epoch || row.holder?.token !== owner.token) {
          return false;
        }

        remove?.();

        return (
          this.#db
            .prepare(
              "DELETE FROM sessions WHERE tenant=? AND name=? AND epoch=? AND holder_token=?",
            )
            .run(this.#tenant, owner.name, owner.epoch, owner.token).changes === 1
        );
      },
      restore,
    );
  }
  async resetProfile(
    owner: Ownership,
    reset: () => void,
    deadline: Deadline,
    restore?: () => void,
  ): Promise<boolean> {
    return await this.#transaction(
      deadline,
      () => {
        const row = this.read(owner.name);

        if (row?.epoch !== owner.epoch || row.holder?.token !== owner.token) {
          return false;
        }

        reset();

        return true;
      },
      restore,
    );
  }
  async releaseSession(owner: Ownership, deadline: Deadline): Promise<boolean> {
    return await this.#transaction(
      deadline,
      () =>
        this.#db
          .prepare(
            "UPDATE sessions SET holder_host=NULL,holder_pid=NULL,holder_start=NULL,holder_token=NULL,expires_at=0 WHERE tenant=? AND name=? AND epoch=? AND holder_token=?",
          )
          .run(this.#tenant, owner.name, owner.epoch, owner.token).changes === 1,
    );
  }
}

export const openStore = async (root: string, deadline: Deadline): Promise<SessionStore> => {
  for (;;) {
    deadline.throwIfExpired();

    try {
      return new SessionStore(root);
    } catch (error) {
      if (!storeIsBusy(error)) {
        throw error;
      }
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- A busy store is opened again only after the previous attempt failed.
    await waitForTurn(deadline);
  }
};

export const newHolderToken = (): string => randomUUID();
