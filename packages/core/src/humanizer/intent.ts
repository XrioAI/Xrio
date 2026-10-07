import type { DisplayTables, HardwareTables } from "./contracts.ts";

export interface IdentityIntent {
  readonly display: DisplayTables | undefined;
  readonly hardware: HardwareTables | undefined;
  readonly locale: string | undefined;
  readonly timezone: string | undefined;
}
