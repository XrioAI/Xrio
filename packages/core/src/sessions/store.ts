/* oxlint-disable anti-slop/no-runtime-typeof -- SQLite rows are parsed into session rows here. */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";

import { untilDeadline } from "../deadline.ts";
import type { Deadline } from "../deadline.ts";
import { XrioError } from "../errors.ts";
import type { SessionBinding, SiteVisit } from "../sources/visit.ts";
import { isStoredProfile, LOCAL_TENANT, storedProfile } from "./profiles.ts";
import type { Holder } from "./profiles.ts";
import { COOLING_RETIREMENT_STREAK, warmthAfter, warmthAt } from "./warmth.ts";
import type { SiteWarmth } from "./warmth.ts";

export type { SessionBinding } from "../sources/visit.ts";

export type SessionState = "ready" | "quarantined" | "retired";

export interface SessionRow {
  readonly name: string;
  readonly pool: string | undefined;
  readonly profileDir: string;
  readonly coolingStreak: number;
  readonly state: SessionState;
  readonly epoch: number;
  readonly holder: Holder | undefined;
  readonly expiresAt: number;
  readonly chromeMajor: number;
  readonly record: string | undefined;
  readonly platform: string | undefined;
  readonly browserArgs: readonly string[] | undefined;
  readonly proxyUrl: string | undefined;
  readonly visits: number;
  readonly createdAt: number;
  readonly lastVisitAt: number;
  readonly binding: SessionBinding;
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
  readonly stickyId: () => string;
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
  readonly binding?: SessionBinding;
  readonly proxyUrl?: string;
  readonly now: number;
  readonly maxAgeMs: number;
}

const SCHEMA_VERSION = 1;

const POLL_INTERVAL_MS = 50;

const SQLITE_BUSY = 5;

const SQLITE_LOCKED = 6;

const STICKY_ID_DRAWS = 100;

const DATABASE_FILE = "xrio.db";

const DATABASE_COMPANIONS = ["-wal", "-shm"] as const;

const PRIVATE_FILE_MODE = 0o600;

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

const profileDirOf = (row: SqlRow): string => {
  const stored = textAt(row, "profile_dir");

  if (!isStoredProfile(stored)) {
    throw new TypeError("Unreadable session column profile_dir.");
  }

  return stored;
};

const bindingOf = (row: SqlRow): SessionBinding => {
  const stickyId = textAt(row, "sticky_id");

  if (row.binding_kind === "unbound" || row.binding_kind === "direct") {
    return { kind: row.binding_kind, stickyId };
  }

  if (row.binding_kind !== "proxy") {
    throw new Error("Unreadable session binding.");
  }

  return {
    kind: "proxy",
    region: { country: textAt(row, "exit_country"), zone: textAt(row, "exit_zone") },
    stickyId,
  };
};

const rowOf = (row: SqlRow): SessionRow => {
  const state = textAt(row, "state");

  if (state !== "ready" && state !== "quarantined" && state !== "retired") {
    throw new Error("Unreadable session state.");
  }

  return {
    binding: bindingOf(row),
    browserArgs: browserArgsOf(row),
    chromeMajor: numberAt(row, "chrome_major"),
    coolingStreak: numberAt(row, "cooling_streak"),
    createdAt: numberAt(row, "created_at"),
    epoch: numberAt(row, "epoch"),
    expiresAt: numberAt(row, "expires_at"),
    holder: holderOf(row),
    lastVisitAt: numberAt(row, "last_visit_at"),
    name: textAt(row, "name"),
    platform: optionalTextAt(row, "platform"),
    pool: optionalTextAt(row, "pool"),
    profileDir: profileDirOf(row),
    proxyUrl: optionalTextAt(row, "proxy_url"),
    record: optionalTextAt(row, "record"),
    state,
    visits: numberAt(row, "visits"),
  };
};

const SCHEMA = `CREATE TABLE sessions(tenant TEXT NOT NULL,name TEXT NOT NULL,pool TEXT,profile_dir TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'ready',
  epoch INTEGER NOT NULL DEFAULT 0,holder_host TEXT,holder_pid INTEGER,holder_start TEXT,holder_token TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,record TEXT,platform TEXT,browser_args TEXT,proxy_url TEXT,chrome_major INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,cooling_streak INTEGER NOT NULL DEFAULT 0,sticky_id TEXT NOT NULL,
  binding_kind TEXT NOT NULL DEFAULT 'unbound',exit_country TEXT,exit_zone TEXT,created_at INTEGER NOT NULL,
  last_visit_at INTEGER NOT NULL,PRIMARY KEY(tenant,name));
CREATE TABLE warmth(tenant TEXT NOT NULL,name TEXT NOT NULL,site TEXT NOT NULL,state TEXT NOT NULL,
  last_visit_at INTEGER NOT NULL,changed_at INTEGER NOT NULL,verdict TEXT NOT NULL,vendor TEXT,challenge_outcome TEXT,
  challenge_rules TEXT NOT NULL,exit_address TEXT,device_digest TEXT NOT NULL,PRIMARY KEY(tenant,name,site),
  FOREIGN KEY(tenant,name) REFERENCES sessions(tenant,name) ON DELETE CASCADE);
CREATE TABLE pools(tenant TEXT NOT NULL,name TEXT NOT NULL,next_member INTEGER NOT NULL,PRIMARY KEY(tenant,name));`;

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

const privateDatabase = (root: string): string => {
  const database = path.join(root, DATABASE_FILE);

  closeSync(openSync(database, "a", PRIVATE_FILE_MODE));
  chmodSync(database, PRIVATE_FILE_MODE);

  for (const companion of DATABASE_COMPANIONS) {
    try {
      chmodSync(`${database}${companion}`, PRIVATE_FILE_MODE);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  return database;
};

const isFree = (row: SessionRow, takeover: Takeover): boolean =>
  row.holder === undefined ||
  takeover.dead.has(row.holder.token) ||
  takeover.now > row.expiresAt + takeover.grace;

const presentableMembers = (members: readonly SessionRow[], check: ClaimRequest["check"]) => {
  const presentable: SessionRow[] = [];
  const refusals: unknown[] = [];

  for (const member of members) {
    try {
      check(member);
      presentable.push(member);
    } catch (error) {
      refusals.push(error);
    }
  }

  return { presentable, refusals };
};

export class SessionStore {
  readonly #db: DatabaseSync;
  readonly #tenant: string;
  constructor(root: string, tenant = LOCAL_TENANT) {
    this.#tenant = tenant;
    this.#db = new DatabaseSync(privateDatabase(root));

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
  poolMembers(pool: string): SessionRow[] {
    return this.#db
      .prepare("SELECT * FROM sessions WHERE tenant=? AND pool=? ORDER BY name")
      .all(this.#tenant, pool)
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
      state=CASE WHEN holder_token IS NOT NULL AND state<>'retired' THEN 'quarantined' ELSE state END WHERE tenant=? AND name=?`)
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
  #inserted(name: string, pool: string | undefined, request: ClaimRequest): SessionRow {
    this.#db
      .prepare(
        "INSERT INTO sessions(tenant,name,pool,profile_dir,created_at,last_visit_at,sticky_id) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        this.#tenant,
        name,
        pool ?? null,
        storedProfile(this.#tenant, name),
        request.now,
        request.now,
        this.unusedStickyId(request.stickyId),
      );

    return this.#claimed(name);
  }
  unusedStickyId(draw: () => string): string {
    const used = this.#db.prepare("SELECT 1 FROM sessions WHERE sticky_id=? LIMIT 1");

    for (let drawn = 0; drawn < STICKY_ID_DRAWS; drawn += 1) {
      const stickyId = draw();

      if (used.get(stickyId) === undefined) {
        return stickyId;
      }
    }

    throw new XrioError(
      "PROXY_SESSION_GENERATION_FAILED",
      "Could not draw a proxy sticky id that no other session uses; increase proxy.session.length.",
      { details: undefined },
    );
  }
  async claimSession(
    name: string,
    request: ClaimRequest,
    deadline: Deadline,
  ): Promise<Claim | undefined> {
    return await this.#transaction(deadline, () => {
      const known = this.read(name);

      if (known === undefined) {
        return this.#take(this.#inserted(name, undefined, request), request, request.major, true);
      }

      request.check(known);

      return this.#take(known, request, request.major, false);
    });
  }
  #nextMemberName(pool: string): string {
    this.#db
      .prepare(
        "INSERT INTO pools(tenant,name,next_member) VALUES(?,?,1) ON CONFLICT(tenant,name) DO NOTHING",
      )
      .run(this.#tenant, pool);

    const number = this.#db
      .prepare("SELECT next_member FROM pools WHERE tenant=? AND name=?")
      .get(this.#tenant, pool);

    if (number === undefined) {
      throw new Error("Pool counter disappeared.");
    }

    this.#db
      .prepare("UPDATE pools SET next_member=next_member+1 WHERE tenant=? AND name=?")
      .run(this.#tenant, pool);

    return `${pool}/${numberAt(number, "next_member")}`;
  }
  async claimPool(
    pool: { readonly name: string; readonly size: number },
    request: ClaimRequest,
    choose: (members: readonly SessionRow[]) => SessionRow | undefined,
    deadline: Deadline,
  ): Promise<Claim | undefined> {
    return await this.#transaction(deadline, () => {
      const live = this.poolMembers(pool.name).filter((member) => member.state !== "retired");
      const { presentable, refusals } = presentableMembers(live, request.check);

      const free = presentable.flatMap((member) =>
        isFree(member, request) ? [{ ...member, holder: undefined }] : [],
      );

      const chosen = choose(free) ?? free.find((member) => member.state === "quarantined");

      if (chosen !== undefined) {
        return this.#take(chosen, request, request.major, false);
      }

      if (live.length < pool.size) {
        const member = this.#inserted(this.#nextMemberName(pool.name), pool.name, request);

        return this.#take(member, request, request.major, true);
      }

      if (presentable.length === 0 && refusals.length > 0) {
        throw refusals[0];
      }

      // oxlint-disable-next-line unicorn/no-useless-undefined -- A full pool has no claim to return.
      return undefined;
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
      .prepare(
        "UPDATE sessions SET cooling_streak=CASE WHEN ?='cooling' AND ?='blocked' THEN cooling_streak+1 ELSE 0 END WHERE tenant=? AND name=?",
      )
      .run(state, visit.verdict, this.#tenant, owner.name);
    this.#db
      .prepare(
        "UPDATE sessions SET state='retired' WHERE tenant=? AND name=? AND pool IS NOT NULL AND cooling_streak>=?",
      )
      .run(this.#tenant, owner.name, COOLING_RETIREMENT_STREAK);
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
            "UPDATE sessions SET chrome_major=MAX(chrome_major,?),state=?,record=COALESCE(record,?),platform=COALESCE(platform,?),browser_args=COALESCE(browser_args,?),proxy_url=?,visits=visits+?,last_visit_at=CASE WHEN ? THEN ? ELSE last_visit_at END WHERE tenant=? AND name=? AND epoch=? AND holder_token=?",
          )
          .run(
            request.major,
            request.exited ? "ready" : "quarantined",
            request.record?.json ?? null,
            request.record?.platform ?? null,
            request.record === undefined ? null : JSON.stringify(request.record.browserArgs),
            request.proxyUrl ?? null,
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

      if (request.binding !== undefined) {
        this.#db
          .prepare(
            "UPDATE sessions SET binding_kind=?,sticky_id=?,exit_country=?,exit_zone=? WHERE tenant=? AND name=?",
          )
          .run(
            request.binding.kind,
            request.binding.stickyId,
            request.binding.kind === "proxy" ? request.binding.region.country : null,
            request.binding.kind === "proxy" ? request.binding.region.zone : null,
            this.#tenant,
            owner.name,
          );
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
