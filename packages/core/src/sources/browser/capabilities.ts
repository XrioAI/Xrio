import type { HostCapabilities } from "../../humanizer/contracts.ts";

export const hostCapabilities = (): HostCapabilities => ({ platform: process.platform });
