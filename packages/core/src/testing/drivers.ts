import { cdpDriver } from "../sources/browser/cdp/driver.ts";
import { patchrightDriver } from "../sources/browser/patchright/driver.ts";
import type { BrowserDriver } from "../sources/browser/port.ts";

export const DRIVERS = {
  cdp: cdpDriver,
  patchright: patchrightDriver,
} as const satisfies Readonly<Record<string, BrowserDriver>>;

export type DriverName = keyof typeof DRIVERS;

export const isDriverName = (name: string): name is DriverName => Object.hasOwn(DRIVERS, name);
