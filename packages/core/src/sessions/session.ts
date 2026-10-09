import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { startDeadline, untilDeadline } from "../deadline.ts";
import type { Clock, Deadline } from "../deadline.ts";
import { publishInternalEvent } from "../diagnostics.ts";
import { clientClosed, invalidOptions, isXrioError, sessionUnavailable } from "../errors.ts";
import type { XrioError } from "../errors.ts";
import type { DeviceRecord, HostCapabilities, Seed } from "../humanizer/contracts.ts";
import type { IdentityContext } from "../humanizer/surfaces.ts";
import type { ScrapeIntent } from "../intent.ts";
import { HeldDeadline } from "../lifetime.ts";
import type { ScrapeOutcome } from "../outcome.ts";
import type { ProfileUse } from "../sources/browser/browser-process.ts";
import type { FinishedVisit, Profile, SiteVisit } from "../sources/visit.ts";
import type { SessionInfo, SessionSummary } from "../types.ts";
import { OwnershipLease, ownershipSchedule } from "./lease.ts";
import type { LeaseExpiry } from "./lease.ts";
import { choosePoolMember } from "./pools.ts";
import {
  cacheDirectory,
  cacheOutsideProfile,
  ensurePrivateDirectory,
  holderIsGone,
  movedProfile,
  processStart,
  tombstonesIn,
} from "./profiles.ts";
import type { CacheHost, Holder } from "./profiles.ts";
import { newHolderToken, openStore, waitForTurn } from "./store.ts";
import type {
  Claim,
  ClaimRequest,
  SessionBinding,
  SessionRow,
  SessionStore,
  Takeover,
} from "./store.ts";
import { DEFAULT_WARMTH_MAX_AGE_MS, warmthAfter, warmthAt } from "./warmth.ts";

interface VisitLaunch {
  readonly browserArgs: readonly string[];
}

export interface SessionHold extends AsyncDisposable {
  readonly device: IdentityContext["device"];
  readonly browserArgs: readonly string[] | undefined;
  readonly profile: Profile;
  readonly binding: SessionBinding | undefined;
  readonly drawStickyId: () => string;
  readonly summary: (visit: SiteVisit, launch: VisitLaunch) => SessionSummary | undefined;
  readonly bind: (deadline: Deadline) => HeldDeadline;
  readonly revisitWanted: (outcome: ScrapeOutcome) => boolean;
  readonly retire: () => Promise<void>;
  readonly finish: (visit: FinishedVisit) => Promise<void>;
}

export interface ClaimChecks {
  readonly seed: () => Seed;
  readonly capabilities?: HostCapabilities;
  readonly check?: (row: SessionRow) => DeviceRecord | undefined;
  readonly stickyId?: () => string;
}

export interface SessionAdmin {
  readonly list: () => Promise<SessionInfo[]>;
  readonly delete: (name: string) => Promise<void>;
  readonly prune: (options: { readonly idleFor: number }) => Promise<string[]>;
}

export interface SessionManager {
  readonly hold: (
    intent: ScrapeIntent["session"],
    checks: ClaimChecks,
    deadline: Deadline,
  ) => Promise<SessionHold>;
  readonly close: () => Promise<void>;
  readonly admin: SessionAdmin;
}

interface SessionOptions {
  readonly databaseDir?: string;
  readonly profileUse: (directory: string, deadline: Deadline) => Promise<ProfileUse>;
  readonly cacheHost?: CacheHost;
  readonly holdMs?: number;
  readonly wallNow?: () => number;
  readonly warmthMaxAgeMs?: number;
}

type PersistentIntent = Exclude<ScrapeIntent["session"], { kind: "anonymous" }>;

interface HeldClaim {
  readonly claim: Claim;
  readonly expiry: LeaseExpiry;
}

type SessionUnavailable = XrioError<"SESSION_UNAVAILABLE">;

const ADMIN_BUDGET_MS = 60_000;

const STORE_OPEN_BUDGET_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const POOL_MEMBER_MAX_IDLE_MS = 7 * DAY_MS;

const HOLDER_RECHECK_MS = 1000;

const stickyIdDraw = (checks: ClaimChecks): (() => string) => checks.stickyId ?? randomUUID;

const anonymousHold = (checks: ClaimChecks, deadline: Deadline): SessionHold => {
  deadline.throwIfExpired();
  const ownership = new AbortController();

  return {
    [Symbol.asyncDispose]: async () => {
      ownership.abort();
      await Promise.resolve();
    },
    bind: (request) => new HeldDeadline(request, ownership.signal),
    binding: undefined,
    browserArgs: undefined,
    device: { kind: "fresh", seed: checks.seed() },
    drawStickyId: stickyIdDraw(checks),
    finish: async () => {
      await Promise.resolve();
    },
    profile: { kind: "scratch" },
    retire: async () => {
      await Promise.resolve();
    },
    revisitWanted: () => false,
    // oxlint-disable-next-line unicorn/no-useless-undefined -- An anonymous visit belongs to no session to summarize.
    summary: () => undefined,
  };
};

interface HolderCheck {
  readonly checkedAt: number;
  readonly gone: Promise<boolean>;
}

const deadHolderChecks = () => {
  const checks = new Map<string, HolderCheck>();

  return async (
    rows: readonly SessionRow[],
    ownStart: string,
    clock: Clock,
  ): Promise<ReadonlySet<string>> => {
    const now = clock.now();

    for (const [token, check] of checks) {
      if (now - check.checkedAt >= HOLDER_RECHECK_MS) {
        checks.delete(token);
      }
    }

    const holders = rows.flatMap((row) => (row.holder === undefined ? [] : [row.holder]));

    const gone = await Promise.all(
      holders.map(async (holder) => {
        const check = checks.get(holder.token) ?? {
          checkedAt: now,
          gone: holderIsGone(holder, ownStart),
        };

        checks.set(holder.token, check);

        return await check.gone;
      }),
    );

    return new Set(holders.flatMap((holder, index) => (gone[index] ? [holder.token] : [])));
  };
};

const ownStart = async (): Promise<string> => {
  const start = await processStart(process.pid);

  if (start === undefined) {
    throw new Error("Cannot identify the session holder process.");
  }

  return start;
};

const profilePaths = (
  profileDir: string,
  browserArgs: readonly string[],
  host: CacheHost | undefined,
) => ({
  cacheDir: cacheDirectory(profileDir, browserArgs, host),
  profileDir,
});

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

class Sessions implements SessionManager {
  readonly #root: string;
  readonly #options: SessionOptions;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #admins = new Set<Promise<void>>();
  readonly #deadHolders = deadHolderChecks();
  #opening: Promise<SessionStore> | undefined;
  #store: SessionStore | undefined;
  #holderStart: Promise<string> | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  constructor(root: string, options: SessionOptions) {
    this.#root = root;
    this.#options = options;
    this.#now = options.wallNow ?? Date.now;
    this.#maxAgeMs = options.warmthMaxAgeMs ?? DEFAULT_WARMTH_MAX_AGE_MS;
  }
  async #openedStore(deadline: Deadline): Promise<SessionStore> {
    deadline.throwIfExpired();
    this.#opening ??= this.#open();
    const opening = this.#opening;

    return await untilDeadline(async () => await opening, deadline);
  }
  async #open(): Promise<SessionStore> {
    using deadline = startDeadline(STORE_OPEN_BUDGET_MS);

    try {
      const databaseDir = this.#options.databaseDir ?? this.#root;
      await ensurePrivateDirectory(this.#root);
      await ensurePrivateDirectory(databaseDir);
      this.#store = await openStore(databaseDir, deadline);
    } catch (error) {
      this.#opening = undefined;
      throw error;
    }

    await this.#sweepTombstones(this.#store, deadline);

    return this.#store;
  }
  async #sweepTombstones(store: SessionStore, deadline: Deadline): Promise<void> {
    try {
      const tombstones = await store.exclusively(() => tombstonesIn(this.#root), deadline);

      await Promise.all(
        tombstones.map(async (tombstone) => {
          await rm(tombstone, { force: true, recursive: true });
        }),
      );
    } catch (error) {
      publishInternalEvent({
        detail: `Removing deleted session profiles failed: ${messageOf(error)}`,
        event: "sweep-incomplete",
      });
    }
  }
  #profileDir(row: SessionRow): string {
    return path.join(this.#root, row.profileDir);
  }
  #sessionInfo(row: SessionRow): SessionInfo {
    const info: SessionInfo = {
      ...profilePaths(this.#profileDir(row), row.browserArgs ?? [], this.#options.cacheHost),
      lastVisitAt: row.lastVisitAt,
      name: row.name,
      state: row.state,
      visits: row.visits,
    };

    return row.pool === undefined ? info : { ...info, pool: row.pool };
  }
  async #holder(): Promise<Holder> {
    this.#holderStart ??= ownStart();
    const starting = this.#holderStart;

    try {
      return { host: hostname(), pid: process.pid, start: await starting, token: newHolderToken() };
    } catch (error) {
      if (this.#holderStart === starting) {
        this.#holderStart = undefined;
      }

      throw error;
    }
  }
  #lease(db: SessionStore, held: HeldClaim, holder: Holder, clock: Clock): OwnershipLease {
    const { row } = held.claim;

    return new OwnershipLease(
      db,
      { epoch: row.epoch, name: row.name, token: holder.token },
      held.expiry,
      { clock, schedule: ownershipSchedule(this.#options.holdMs), wallNow: this.#now },
    );
  }
  #takeover(holder: Holder, dead: ReadonlySet<string>): Takeover {
    const schedule = ownershipSchedule(this.#options.holdMs);

    return { dead, grace: schedule.graceMs, holder, length: schedule.holdMs, now: this.#now() };
  }
  static #held(claim: Claim, claimedAt: number, length: number): HeldClaim {
    return { claim, expiry: { monotonic: claimedAt + length, wall: claim.row.expiresAt } };
  }
  async #turn(key: string, deadline: Deadline): Promise<() => void> {
    const prior = this.#queues.get(key) ?? Promise.resolve();
    const next = Promise.withResolvers<null>();

    const queued = (async () => {
      await prior;
      await next.promise;
    })();

    this.#queues.set(key, queued);

    const release = () => {
      next.resolve(null);

      if (this.#queues.get(key) === queued) {
        this.#queues.delete(key);
      }
    };

    try {
      await untilDeadline(async () => {
        await prior;
      }, deadline);

      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  static #claimCheck(checks: ClaimChecks, row: SessionRow): void {
    if (row.chromeMajor > (checks.capabilities?.chromeMajor ?? 0)) {
      throw sessionUnavailable("browser-too-old");
    }

    checks.check?.(row);
  }
  #warmth(db: SessionStore, name: string, site: string) {
    return warmthAt(db.siteWarmth(name, site), this.#now(), this.#maxAgeMs);
  }
  #chooser(db: SessionStore, site: string) {
    return (members: readonly SessionRow[]) =>
      choosePoolMember(members, (name) => this.#warmth(db, name, site));
  }
  async #claim(
    intent: PersistentIntent,
    checks: ClaimChecks,
    db: SessionStore,
    holder: Holder,
    deadline: Deadline,
  ): Promise<HeldClaim> {
    // oxlint-disable no-await-in-loop -- A waiting claim polls the store until its holder releases or dies.
    for (;;) {
      const rows =
        intent.kind === "pool"
          ? db.poolMembers(intent.name)
          : [db.read(intent.name)].filter((row) => row !== undefined);

      const request: ClaimRequest = {
        ...this.#takeover(holder, await this.#deadHolders(rows, holder.start, deadline.clock)),
        check: (row) => {
          Sessions.#claimCheck(checks, row);
        },
        major: checks.capabilities?.chromeMajor ?? 0,
        stickyId: stickyIdDraw(checks),
      };

      const claimedAt = deadline.clock.now();

      const claim =
        intent.kind === "pool"
          ? await db.claimPool(intent, request, this.#chooser(db, intent.site), deadline)
          : await db.claimSession(intent.name, request, deadline);

      if (claim !== undefined) {
        return Sessions.#held(claim, claimedAt, request.length);
      }

      await waitForTurn(deadline);
    }
    // oxlint-enable no-await-in-loop
  }
  static async #recordedProfileExists(
    row: SessionRow,
    lease: OwnershipLease,
    directory: string,
  ): Promise<void> {
    if (row.record === undefined) {
      return;
    }

    try {
      await lstat(directory);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }

      await lease.state(row.pool === undefined ? "quarantined" : "retired");
      throw sessionUnavailable("quarantined");
    }
  }
  async #refuseOpenProfile(
    row: SessionRow,
    lease: OwnershipLease,
    directory: string,
    deadline: Deadline,
  ): Promise<void> {
    const use = await this.#options.profileUse(directory, deadline);

    if (use === "unknown") {
      throw sessionUnavailable(
        "process-table-unreadable",
        "The process table could not be read to check that Chrome left the session's profile.",
      );
    }

    if (use === "in-use") {
      await lease.state(row.pool === undefined ? "quarantined" : "retired");
      publishInternalEvent({ detail: row.name, event: "session-quarantined" });
      throw sessionUnavailable("quarantined");
    }
  }
  static async #resetProfile(
    lease: OwnershipLease,
    db: SessionStore,
    directory: string,
  ): Promise<void> {
    const removed = movedProfile(directory);
    using persistence = lease.persistence();

    const reset = await db.resetProfile(
      lease.owner,
      () => {
        removed.move();
        mkdirSync(directory, { mode: 0o700 });
      },
      persistence,
      removed.restore,
    );

    if (!reset) {
      throw sessionUnavailable("ownership-lost");
    }

    await removed.settle();
  }
  async #profileReady(
    row: SessionRow,
    lease: OwnershipLease,
    db: SessionStore,
    deadline: Deadline,
  ): Promise<string> {
    const directory = this.#profileDir(row);

    await Sessions.#recordedProfileExists(row, lease, directory);
    await ensurePrivateDirectory(directory);
    const held = deadline.boundTo(lease.signal, "ownership");

    await this.#refuseOpenProfile(row, lease, directory, held);
    held.throwIfExpired();
    await lease.state("ready");

    if (row.record === undefined) {
      await Sessions.#resetProfile(lease, db, directory);
      await this.#removeCacheOutsideProfile(row, directory);
    }

    held.throwIfExpired();

    return directory;
  }
  async #persistentHold(
    held: HeldClaim,
    holder: Holder,
    checks: ClaimChecks,
    db: SessionStore,
    deadline: Deadline,
    releaseTurn: () => void,
  ): Promise<SessionHold> {
    const { row } = held.claim;
    const lease = this.#lease(db, held, holder, deadline.clock);

    try {
      const record = checks.check?.(row);

      const device: IdentityContext["device"] =
        record === undefined ? { kind: "fresh", seed: checks.seed() } : { kind: "record", record };

      const directory = await this.#profileReady(row, lease, db, deadline);
      publishInternalEvent({ detail: row.name, event: "session-claimed" });

      return this.#heldVisit({
        checks,
        claim: held.claim,
        db,
        device,
        directory,
        lease,
        releaseTurn,
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
  }
  #warmthChanges(db: SessionStore, name: string, visit: SiteVisit | undefined): boolean {
    if (visit === undefined) {
      return false;
    }

    const before = this.#warmth(db, name, visit.site);

    return before !== warmthAfter(before, visit.verdict);
  }
  #heldVisit(context: {
    readonly claim: Claim;
    readonly checks: ClaimChecks;
    readonly db: SessionStore;
    readonly releaseTurn: () => void;
    readonly lease: OwnershipLease;
    readonly device: IdentityContext["device"];
    readonly directory: string;
  }): SessionHold {
    const { claim, checks, db, lease, device, directory, releaseTurn } = context;
    const { name, pool } = claim.row;

    return {
      [Symbol.asyncDispose]: async () => {
        await lease.release();
        releaseTurn();

        if (pool !== undefined) {
          await this.#prunePool(pool);
        }
      },
      bind: (request) => new HeldDeadline(request, lease.signal),
      binding: claim.row.binding,
      browserArgs: claim.row.browserArgs,
      device,
      drawStickyId: () => db.unusedStickyId(stickyIdDraw(checks)),
      finish: async (visit) => {
        const warmthChanges = this.#warmthChanges(db, name, visit.siteVisit);
        using deadline = lease.persistence();

        const written = await db.finishVisit(
          lease.owner,
          {
            binding: visit.binding,
            exited: visit.closed.exited,
            major: checks.capabilities?.chromeMajor ?? 0,
            maxAgeMs: this.#maxAgeMs,
            now: this.#now(),
            record:
              visit.record === null
                ? undefined
                : {
                    browserArgs: visit.browserArgs,
                    json: JSON.stringify(visit.record),
                    platform: checks.capabilities?.platform ?? process.platform,
                  },
            siteVisit: visit.siteVisit,
          },
          deadline,
        );

        if (!written) {
          lease.lost();

          return;
        }

        if (!visit.closed.exited) {
          publishInternalEvent({ detail: name, event: "session-quarantined" });
        }

        if (warmthChanges) {
          publishInternalEvent({ detail: name, event: "warmth-changed" });
        }
      },
      profile: { dir: directory, kind: "persistent" },
      retire: async () => {
        if (pool !== undefined) {
          await lease.state("retired");
        }
      },
      revisitWanted: () => false,
      summary: (visit, launch) => {
        const summary: SessionSummary = {
          ...profilePaths(directory, launch.browserArgs, this.#options.cacheHost),
          created: claim.created,
          name,
          visits: claim.row.visits + 1,
          warmth: warmthAfter(this.#warmth(db, name, visit.site), visit.verdict),
        };

        return pool === undefined ? summary : { ...summary, pool };
      },
    };
  }
  static #checkBeforeWaiting(
    intent: PersistentIntent,
    checks: ClaimChecks,
    db: SessionStore,
  ): void {
    const existing = intent.kind === "named" ? db.read(intent.name) : undefined;

    if (existing !== undefined) {
      Sessions.#claimCheck(checks, existing);
    }
  }
  async #heldMember(
    intent: PersistentIntent,
    checks: ClaimChecks,
    db: SessionStore,
    deadline: Deadline,
    releaseTurn: () => void,
  ): Promise<SessionHold> {
    const holder = await this.#holder();

    // oxlint-disable no-await-in-loop -- A pool claims its next member only after the previous one was retired.
    for (;;) {
      const held = await this.#claim(intent, checks, db, holder, deadline);

      try {
        const owned = await this.#persistentHold(held, holder, checks, db, deadline, releaseTurn);

        if (intent.kind === "pool") {
          releaseTurn();
        }

        return owned;
      } catch (error) {
        if (
          intent.kind !== "pool" ||
          !isXrioError(error, "SESSION_UNAVAILABLE") ||
          error.details.reason !== "quarantined"
        ) {
          throw error;
        }
      }
    }
    // oxlint-enable no-await-in-loop
  }
  async hold(
    intent: ScrapeIntent["session"],
    checks: ClaimChecks,
    deadline: Deadline,
  ): Promise<SessionHold> {
    if (this.#closed) {
      throw clientClosed();
    }

    if (intent.kind === "anonymous") {
      return anonymousHold(checks, deadline);
    }

    const db = await this.#openedStore(deadline);

    Sessions.#checkBeforeWaiting(intent, checks, db);

    const releaseTurn = await this.#turn(`${intent.kind}:${intent.name}`, deadline);

    try {
      return await this.#heldMember(intent, checks, db, deadline, releaseTurn);
    } catch (error) {
      releaseTurn();
      throw error;
    }
  }
  async #removalClaim(
    db: SessionStore,
    name: string,
    removal: { readonly eligible: (row: SessionRow) => boolean; readonly waits: boolean },
    holder: Holder,
    deadline: Deadline,
  ): Promise<HeldClaim | undefined> {
    // oxlint-disable no-await-in-loop -- A waiting delete polls the store until the holder releases or dies.
    for (;;) {
      const rows = [db.read(name)].filter((row) => row !== undefined);
      const dead = await this.#deadHolders(rows, holder.start, deadline.clock);
      const takeover = this.#takeover(holder, dead);
      const claimedAt = deadline.clock.now();
      const result = await db.claimForRemoval(name, takeover, removal.eligible, deadline);

      if (result.kind === "claimed") {
        return Sessions.#held(result.claim, claimedAt, takeover.length);
      }

      if (result.kind === "skipped" || !removal.waits) {
        return undefined;
      }

      await waitForTurn(deadline);
    }
    // oxlint-enable no-await-in-loop
  }
  async #removeClaimed(
    db: SessionStore,
    held: HeldClaim,
    holder: Holder,
    deadline: Deadline,
  ): Promise<SessionUnavailable | undefined> {
    const { row } = held.claim;
    const lease = this.#lease(db, held, holder, deadline.clock);
    const directory = this.#profileDir(row);

    try {
      await this.#refuseOpenProfile(
        row,
        lease,
        directory,
        deadline.boundTo(lease.signal, "ownership"),
      );
      await this.#removeCacheOutsideProfile(row, directory);

      const removed = movedProfile(directory);
      using persistence = lease.persistence();

      if (!(await db.deleteSession(lease.owner, persistence, removed.move, removed.restore))) {
        return sessionUnavailable("ownership-lost");
      }

      await removed.settle();

      return undefined;
    } catch (error) {
      if (isXrioError(error, "SESSION_UNAVAILABLE")) {
        return error;
      }

      throw error;
    } finally {
      await lease.release();
    }
  }
  async #removeCacheOutsideProfile(row: SessionRow, profileDir: string): Promise<void> {
    try {
      const cache = cacheOutsideProfile(profileDir, row.browserArgs ?? [], this.#options.cacheHost);

      if (cache !== undefined) {
        await rm(cache, { force: true, recursive: true });
      }
    } catch (error) {
      publishInternalEvent({
        detail: `Removing the cache of session ${row.name} failed: ${messageOf(error)}`,
        event: "sweep-incomplete",
      });
    }
  }
  async #delete(name: string): Promise<void> {
    using deadline = startDeadline(ADMIN_BUDGET_MS);
    const db = await this.#openedStore(deadline);
    const holder = await this.#holder();
    const removal = { eligible: () => true, waits: true };
    const held = await this.#removalClaim(db, name, removal, holder, deadline);

    const kept =
      held === undefined ? undefined : await this.#removeClaimed(db, held, holder, deadline);

    if (kept !== undefined) {
      throw kept;
    }
  }
  async #pruneRows(eligible: (row: SessionRow) => boolean): Promise<string[]> {
    using deadline = startDeadline(ADMIN_BUDGET_MS);
    const db = await this.#openedStore(deadline);
    const holder = await this.#holder();
    const removal = { eligible, waits: false };
    const deleted: string[] = [];

    // oxlint-disable no-await-in-loop -- Each removal claims, checks and deletes one session before the next.
    for (const row of db.list().filter(eligible)) {
      const held = await this.#removalClaim(db, row.name, removal, holder, deadline);

      if (
        held !== undefined &&
        (await this.#removeClaimed(db, held, holder, deadline)) === undefined
      ) {
        deleted.push(row.name);
      }
    }
    // oxlint-enable no-await-in-loop

    return deleted;
  }
  async #prunePool(pool: string): Promise<void> {
    try {
      await this.#pruneRows(
        (row) =>
          row.pool === pool &&
          (row.state === "retired" || this.#now() - row.lastVisitAt > POOL_MEMBER_MAX_IDLE_MS),
      );
    } catch (error) {
      publishInternalEvent({
        detail: `Pruning pool ${pool} failed: ${messageOf(error)}`,
        event: "pool-prune-failed",
      });
    }
  }
  async #list(): Promise<SessionInfo[]> {
    using deadline = startDeadline(ADMIN_BUDGET_MS);
    const db = await this.#openedStore(deadline);

    return db.list().map((row) => this.#sessionInfo(row));
  }
  async #adminRun<Result>(run: () => Promise<Result>): Promise<Result> {
    if (this.#closed) {
      throw clientClosed();
    }

    const result = run();

    const settled = (async () => {
      await result;
    })();

    this.#admins.add(settled);

    try {
      return await result;
    } finally {
      this.#admins.delete(settled);
      void Promise.allSettled([settled]);
    }
  }
  get admin(): SessionAdmin {
    return {
      delete: async (name) => {
        await this.#adminRun(async () => {
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JavaScript callers can pass any value.
          if (typeof name !== "string" || name.length === 0) {
            throw invalidOptions("A session name is required.");
          }

          await this.#delete(name);
        });
      },
      list: async () => await this.#adminRun(async () => await this.#list()),
      prune: async ({ idleFor }) =>
        await this.#adminRun(async () => {
          if (!Number.isSafeInteger(idleFor) || idleFor < 0) {
            throw invalidOptions("idleFor must be a non-negative integer.");
          }

          return await this.#pruneRows((row) => this.#now() - row.lastVisitAt > idleFor);
        }),
    };
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      await Promise.allSettled(this.#admins);
      await Promise.allSettled([this.#opening]);
      this.#store?.close();
    })();
    await this.#closing;
  }
}

export const createSessions = (root: string, options: SessionOptions): SessionManager =>
  new Sessions(root, options);
