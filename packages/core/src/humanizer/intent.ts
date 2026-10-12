import type { DisplayTables, HardwareTables, NoisePolicy } from "./contracts.ts";

export interface IdentityIntent {
  readonly display: DisplayTables | undefined;
  readonly hardware: HardwareTables | undefined;
  readonly locale: string | undefined;
  readonly noise: NoisePolicy | undefined;
  readonly timezone: string | undefined;
}
