import type { Closed, DeviceRecord } from "../humanizer/contracts.ts";

export type SessionId = string;

export interface Ownership {
  readonly epoch: number;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}

export interface ResolvedPins {
  readonly locale: string | undefined;
  readonly timezone: string | undefined;
}

export type SessionContext =
  | { readonly kind: "anonymous"; readonly ownership: Pick<Ownership, "signal"> }
  | {
      readonly kind: "named";
      readonly id: SessionId;
      readonly record: DeviceRecord;
      readonly pins: ResolvedPins;
      readonly ownership: Ownership;
    };

type NamedSession = Extract<SessionContext, { kind: "named" }>;

export interface ClaimRequest {
  readonly id: SessionId;
  readonly holdMs: number;
}

export type ProfileAfterVisit =
  | { readonly state: "reusable" }
  | { readonly state: "quarantined"; readonly reason: string };

const RENEW_AT_FRACTION_OF_HOLD = 1 / 3;

const LOCAL_ABORT_MARGIN_MS = 10_000;

const CLAIM_GRACE_MS = 5000;

const MIN_HOLD_MS = 30_000;

export type HoldRefusal =
  | { readonly kind: "not-safe-integer"; readonly field: "claimedAt" | "expiresAt" }
  | { readonly kind: "too-short"; readonly holdMs: number };

const describeHoldRefusal = (refusal: HoldRefusal): string =>
  refusal.kind === "not-safe-integer"
    ? `Ownership ${refusal.field} must be a safe integer of milliseconds.`
    : `An ownership hold of ${refusal.holdMs} ms is shorter than the ${MIN_HOLD_MS} ms minimum.`;

export class HoldRefusedError extends Error {
  override readonly name = "HoldRefusedError";
  readonly refusal: HoldRefusal;

  constructor(refusal: HoldRefusal) {
    super(describeHoldRefusal(refusal));
    this.refusal = refusal;
  }
}

export const ownershipSchedule = (
  claimedAt: number,
  { expiresAt }: Pick<Ownership, "expiresAt">,
) => {
  if (!Number.isSafeInteger(claimedAt)) {
    throw new HoldRefusedError({ field: "claimedAt", kind: "not-safe-integer" });
  }

  if (!Number.isSafeInteger(expiresAt)) {
    throw new HoldRefusedError({ field: "expiresAt", kind: "not-safe-integer" });
  }

  const holdMs = expiresAt - claimedAt;

  if (holdMs < MIN_HOLD_MS) {
    throw new HoldRefusedError({ holdMs, kind: "too-short" });
  }

  return {
    abortAt: expiresAt - LOCAL_ABORT_MARGIN_MS,
    claimableAt: expiresAt + CLAIM_GRACE_MS,
    renewAt: claimedAt + holdMs * RENEW_AT_FRACTION_OF_HOLD,
  };
};

export const profileAfterVisit = (closed: Closed): ProfileAfterVisit =>
  closed.exited
    ? { state: "reusable" }
    : {
        reason: `Quarantined until the startup sweep finds no process holding it: ${closed.reason}`,
        state: "quarantined",
      };

export const sessionFor = (): SessionContext => ({
  kind: "anonymous",
  ownership: { signal: new AbortController().signal },
});

const notImplemented = (operation: string): Error =>
  new Error(`${operation} is not implemented until the session manager exists.`);

export const claimSession = async (_request: ClaimRequest): Promise<NamedSession> =>
  await Promise.reject(notImplemented("claimSession"));

export const renewOwnership = async (_session: NamedSession): Promise<Ownership> =>
  await Promise.reject(notImplemented("renewOwnership"));

export const finishVisit = async (
  _session: NamedSession,
  _closed: Closed,
): Promise<ProfileAfterVisit> => await Promise.reject(notImplemented("finishVisit"));

export const releaseSession = async (_session: NamedSession): Promise<void> => {
  await Promise.reject(notImplemented("releaseSession"));
};
