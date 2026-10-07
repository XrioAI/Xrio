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

export interface ChromeProduct {
  readonly major: number;
  readonly version: string;
  readonly headless: boolean;
}

export interface DriverBrowser {
  readonly product: ChromeProduct;
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

export const CLEANUP_BUDGET_MS = 2000;

export const TEARDOWN_BUDGET_MS = 10_000;

type ProcessSink = (pid: number) => void;

type CleanupSink = (cleanup: Promise<void>) => void;

export interface BrowserDriver {
  readonly launch: (
    plan: LaunchPlan,
    deadline: Deadline,
    owned: ProcessSink,
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

const CHROME_PRODUCT = /^(?<token>HeadlessChrome|Chrome)\/(?<major>\d+)\.\d+\.\d+\.\d+$/u;

export const parseChromeProduct = (product: string): ChromeProduct => {
  const match = CHROME_PRODUCT.exec(product);
  const token = match?.groups?.token;
  const major = Number(match?.groups?.major);

  if (token === undefined || !Number.isSafeInteger(major) || major <= 0) {
    throw new DriverError({
      kind: "launch-failed",
      problem: `Chrome reported a malformed product ${product}.`,
    });
  }

  return {
    headless: token === "HeadlessChrome",
    major,
    version: product.slice(token.length + 1),
  };
};
