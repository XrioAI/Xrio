import type { Deadline } from "../../deadline.ts";
import type { LaunchPlan } from "./launch-plan.ts";

export type RawHeaders = readonly (readonly [string, string])[];

export interface DocumentHop {
  requestId: string;
  loaderId: string;
  url: string;
  status: number;
  headers: RawHeaders;
  isRedirect: boolean;
}

export type DriverEvent =
  | { type: "commit"; frameId: string; loaderId: string }
  | { type: "dom-content-loaded"; frameId: string; loaderId: string }
  | { type: "document-response"; hop: DocumentHop }
  | { type: "raw-headers"; requestId: string; status: number; headers: RawHeaders }
  | { type: "request"; url: string }
  | { type: "crash" }
  | { type: "disconnect" };

export type DriverListener = (event: DriverEvent) => void;

export type ResultGuard<Result> = (value: unknown) => value is Result;

export interface DriverBrowser {
  readonly pid: number;
  readonly product: string;
  readonly onEvent: (listener: DriverListener) => () => void;
  readonly navigate: (url: string, deadline: Deadline) => Promise<void>;
  readonly evaluateIsolated: <Result>(
    expression: string,
    isResult: ResultGuard<Result>,
    deadline: Deadline,
  ) => Promise<Result>;
  readonly close: (budgetMs: number) => Promise<void>;
}

export const CLOSE_BUDGET_MS = 2000;

export type CleanupSink = (cleanup: Promise<void>) => void;

export interface BrowserDriver {
  readonly launch: (
    plan: LaunchPlan,
    deadline: Deadline,
    deferCleanup: CleanupSink,
  ) => Promise<DriverBrowser>;
}

export type DriverErrorReason =
  | { kind: "navigation-failed"; netError: string }
  | { kind: "document-replaced" }
  | { kind: "browser-gone" }
  | { kind: "launch-failed"; problem: string };

const FIXED_DESCRIPTIONS = {
  "browser-gone": "The browser or its renderer died.",
  "document-replaced": "The document was replaced while it was being read.",
} as const;

const describe = (reason: DriverErrorReason): string => {
  if (reason.kind === "navigation-failed") {
    return `Navigation failed with ${reason.netError}.`;
  }

  return reason.kind === "launch-failed" ? reason.problem : FIXED_DESCRIPTIONS[reason.kind];
};

export class DriverError extends Error {
  override readonly name = "DriverError";
  readonly reason: DriverErrorReason;

  constructor(reason: DriverErrorReason, options?: ErrorOptions) {
    super(describe(reason), options);
    this.reason = reason;
  }
}
