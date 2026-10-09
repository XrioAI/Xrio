import { mkdirSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { hostname } from "node:os";

import { startDeadline, untilDeadline } from "../deadline.ts";
import type { Clock, Deadline } from "../deadline.ts";
import { publishInternalEvent } from "../diagnostics.ts";
import { clientClosed, sessionUnavailable } from "../errors.ts";
import type { DeviceRecord, HostCapabilities, Seed } from "../humanizer/contracts.ts";
import type { IdentityContext } from "../humanizer/surfaces.ts";
import type { ScrapeIntent } from "../intent.ts";
import { HeldDeadline } from "../lifetime.ts";
import type { ScrapeOutcome } from "../outcome.ts";
import type { ProfileUse } from "../sources/browser/browser-process.ts";
import type { FinishedVisit, Profile } from "../sources/visit.ts";
import { OwnershipLease, ownershipSchedule } from "./lease.ts";
import type { LeaseExpiry } from "./lease.ts";
import {
  ensurePrivateDirectory,
  holderIsGone,
  LOCAL_TENANT,
  movedProfile,
  processStart,
  profileDirectory,
} from "./profiles.ts";
import type { Holder } from "./profiles.ts";
import { newHolderToken, openStore, waitForTurn } from "./store.ts";
import type { Claim, ClaimRequest, SessionRow, SessionStore, Takeover } from "./store.ts";

export interface SessionHold extends AsyncDisposable {
  readonly device: IdentityContext["device"];
  readonly browserArgs: readonly string[] | undefined;
  readonly profile: Profile;
  readonly bind: (deadline: Deadline) => HeldDeadline;
  readonly revisitWanted: (outcome: ScrapeOutcome) => boolean;
  readonly finish: (visit: FinishedVisit) => Promise<void>;
}

export interface ClaimChecks {
  readonly seed: () => Seed;
  readonly capabilities?: HostCapabilities;
  readonly check?: (row: SessionRow) => DeviceRecord | undefined;
}

export interface SessionManager {
  readonly hold: (
    intent: ScrapeIntent["session"],
    checks: ClaimChecks,
    deadline: Deadline,
  ) => Promise<SessionHold>;
  readonly close: () => Promise<void>;
}

interface SessionOptions {
  readonly databaseDir?: string;
  readonly profileUse: (directory: string, deadline: Deadline) => Promise<ProfileUse>;
  readonly holdMs?: number;
  readonly wallNow?: () => number;
}

type PersistentIntent = Exclude<ScrapeIntent["session"], { kind: "anonymous" }>;

interface HeldClaim {
  readonly claim: Claim;
  readonly expiry: LeaseExpiry;
}

const STORE_OPEN_BUDGET_MS = 30_000;

const HOLDER_RECHECK_MS = 1000;

const anonymousHold = (checks: ClaimChecks, deadline: Deadline): SessionHold => {
  deadline.throwIfExpired();
  const ownership = new AbortController();

  return {
    [Symbol.asyncDispose]: async () => {
      ownership.abort();
      await Promise.resolve();
    },
    bind: (request) => new HeldDeadline(request, ownership.signal),
    browserArgs: undefined,
    device: { kind: "fresh", seed: checks.seed() },
    finish: async () => {
      await Promise.resolve();
    },
    profile: { kind: "scratch" },
    revisitWanted: () => false,
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

class Sessions implements SessionManager {
  readonly #root: string;
  readonly #options: SessionOptions;
  readonly #now: () => number;
  readonly #queues = new Map<string, Promise<void>>();
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

    return this.#store;
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
  async #claim(
    intent: PersistentIntent,
    checks: ClaimChecks,
    db: SessionStore,
    holder: Holder,
    deadline: Deadline,
  ): Promise<HeldClaim> {
    // oxlint-disable no-await-in-loop -- A waiting claim polls the store until its holder releases or dies.
    for (;;) {
      const rows = [db.read(intent.name)].filter((row) => row !== undefined);

      const request: ClaimRequest = {
        ...this.#takeover(holder, await this.#deadHolders(rows, holder.start, deadline.clock)),
        check: (row) => {
          Sessions.#claimCheck(checks, row);
        },
        major: checks.capabilities?.chromeMajor ?? 0,
      };

      const claimedAt = deadline.clock.now();
      const claim = await db.claimSession(intent.name, request, deadline);

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

      await lease.state("quarantined");
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
      await lease.state("quarantined");
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
    const directory = profileDirectory(this.#root, LOCAL_TENANT, row.name);

    await Sessions.#recordedProfileExists(row, lease, directory);
    await ensurePrivateDirectory(directory);
    const held = deadline.boundTo(lease.signal, "ownership");

    await this.#refuseOpenProfile(row, lease, directory, held);
    held.throwIfExpired();
    await lease.state("ready");

    if (row.record === undefined) {
      await Sessions.#resetProfile(lease, db, directory);
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
    const { name } = claim.row;

    return {
      [Symbol.asyncDispose]: async () => {
        await lease.release();
        releaseTurn();
      },
      bind: (request) => new HeldDeadline(request, lease.signal),
      browserArgs: claim.row.browserArgs,
      device,
      finish: async (visit) => {
        using deadline = lease.persistence();

        const written = await db.finishVisit(
          lease.owner,
          {
            exited: visit.closed.exited,
            major: checks.capabilities?.chromeMajor ?? 0,
            now: this.#now(),
            record:
              visit.record === null
                ? undefined
                : {
                    browserArgs: visit.browserArgs,
                    json: JSON.stringify(visit.record),
                    platform: checks.capabilities?.platform ?? process.platform,
                  },
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
      },
      profile: { dir: directory, kind: "persistent" },
      revisitWanted: () => false,
    };
  }
  static #checkBeforeWaiting(
    intent: PersistentIntent,
    checks: ClaimChecks,
    db: SessionStore,
  ): void {
    const existing = db.read(intent.name);

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
    const held = await this.#claim(intent, checks, db, holder, deadline);

    return await this.#persistentHold(held, holder, checks, db, deadline, releaseTurn);
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
  async close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      await Promise.allSettled([this.#opening]);
      this.#store?.close();
    })();
    await this.#closing;
  }
}

export const createSessions = (root: string, options: SessionOptions): SessionManager =>
  new Sessions(root, options);
