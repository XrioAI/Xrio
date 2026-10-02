import { cdpDriver } from "./cdp/driver.ts";
import { patchrightDriver } from "./patchright/driver.ts";
import type { BrowserDriver } from "./port.ts";

export const BROWSER_DRIVERS = {
  cdp: cdpDriver,
  patchright: patchrightDriver,
} as const satisfies Readonly<Record<string, BrowserDriver>>;

export type BrowserDriverName = keyof typeof BROWSER_DRIVERS;

export const isBrowserDriverName = (name: string): name is BrowserDriverName =>
  Object.hasOwn(BROWSER_DRIVERS, name);
