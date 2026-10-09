import { startDeadline } from "../deadline.ts";
import type { Clock, Deadline } from "../deadline.ts";
import { publishInternalEvent } from "../diagnostics.ts";
import { sessionUnavailable } from "../errors.ts";
import type { Ownership, SessionState, SessionStore } from "./store.ts";

const DEFAULT_HOLD_MS = 60_000;

const MIN_HOLD_MS = 30_000;

const ABORT_LEAD_MS = 10_000;

const TAKEOVER_GRACE_MS = 5000;

const RENEWALS_PER_HOLD = 3;

export const ownershipSchedule = (holdMs = DEFAULT_HOLD_MS) => {
  if (!Number.isFinite(holdMs) || holdMs < MIN_HOLD_MS) {
    throw new Error(`A session hold must last at least ${MIN_HOLD_MS} ms.`);
  }

  return { graceMs: TAKEOVER_GRACE_MS, holdMs, renewMs: holdMs / RENEWALS_PER_HOLD };
};

type OwnershipSchedule = ReturnType<typeof ownershipSchedule>;

export interface LeaseExpiry {
  readonly monotonic: number;
  readonly wall: number;
}

export interface LeaseClocks {
  readonly clock: Clock;
  readonly wallNow: () => number;
  readonly schedule: OwnershipSchedule;
}

export class OwnershipLease {
  readonly signal: AbortSignal;
  readonly owner: Ownership;
  readonly #abort = new AbortController();
  readonly #store: SessionStore;
  readonly #clocks: LeaseClocks;
  #expiry: LeaseExpiry;
  #released = false;
  #cancelRenew: (() => void) | undefined;
  #cancelAbort: (() => void) | undefined;
  #renewing: Promise<void> | undefined;

  constructor(store: SessionStore, owner: Ownership, expiry: LeaseExpiry, clocks: LeaseClocks) {
    this.#store = store;
    this.owner = owner;
    this.#expiry = expiry;
    this.#clocks = clocks;
    this.signal = this.#abort.signal;
    this.#arm();
  }
  #untilExpiry(): number {
    const { clock, wallNow } = this.#clocks;

    return Math.min(this.#expiry.monotonic - clock.now(), this.#expiry.wall - wallNow());
  }
  #remainingMs(): number {
    return this.#untilExpiry() - ABORT_LEAD_MS;
  }
  persistence(): Deadline & Disposable {
    const remaining = this.#remainingMs();

    if (remaining <= 0 || this.signal.aborted) {
      this.lost();
      throw sessionUnavailable("ownership-lost");
    }

    return startDeadline(remaining, this.signal, this.#clocks.clock);
  }
  lost(): void {
    if (this.#released || this.signal.aborted) {
      return;
    }

    this.#abort.abort(sessionUnavailable("ownership-lost"));
    publishInternalEvent({ detail: this.owner.name, event: "ownership-lost" });
  }
  #arm(): void {
    const { clock, schedule } = this.#clocks;

    this.#cancelAbort?.();
    this.#cancelRenew?.();
    this.#cancelAbort = clock.setTimer(Math.max(0, this.#remainingMs()), () => {
      this.lost();
    });
    this.#cancelRenew = clock.setTimer(schedule.renewMs, () => {
      this.#renewing = this.#renew();
      void Promise.allSettled([this.#renewing]);
    });
  }
  async #renew(): Promise<void> {
    if (this.#remainingMs() <= 0) {
      this.lost();

      return;
    }

    const { clock, schedule, wallNow } = this.#clocks;

    const renewed = {
      monotonic: clock.now() + schedule.holdMs,
      wall: wallNow() + schedule.holdMs,
    };

    using deadline = startDeadline(Math.max(1, this.#remainingMs()), undefined, clock);

    try {
      if (!(await this.#store.renewOwnership(this.owner, renewed.wall, deadline))) {
        this.lost();

        return;
      }

      if (!this.#released && !this.signal.aborted) {
        this.#expiry = renewed;
        this.#arm();
      }
    } catch {
      this.lost();
    }
  }
  async state(state: SessionState): Promise<void> {
    using deadline = this.persistence();

    if (!(await this.#store.sessionState(this.owner, state, deadline))) {
      throw sessionUnavailable("ownership-lost");
    }
  }
  async #releasedInStore(): Promise<boolean> {
    using deadline = startDeadline(Math.max(1, this.#untilExpiry()), undefined, this.#clocks.clock);

    try {
      return await this.#store.releaseSession(this.owner, deadline);
    } catch {
      return false;
    }
  }
  async release(): Promise<void> {
    if (this.#released) {
      return;
    }

    this.#released = true;
    this.#cancelRenew?.();
    this.#cancelAbort?.();
    await this.#renewing;

    if (await this.#releasedInStore()) {
      publishInternalEvent({ detail: this.owner.name, event: "session-released" });
    }

    this.#abort.abort();
  }
}
