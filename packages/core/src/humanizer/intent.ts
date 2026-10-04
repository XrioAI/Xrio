import type { DisplayTables } from "./contracts.ts";

export interface IdentityIntent {
  readonly display: DisplayTables | undefined;
  readonly locale: string | undefined;
  readonly timezone: string | undefined;
}
