import { describe, expect, it } from "vite-plus/test";

import { startDeadline } from "./deadline.ts";
import { httpIdentity, planIdentity } from "./humanizer/humanizer.ts";
import { HeldDeadline } from "./lifetime.ts";
import { Slot } from "./slot.ts";
import type { BrowserDriver } from "./sources/browser/port.ts";
import { createSources } from "./sources/source.ts";
import type { VisitPlan } from "./sources/visit.ts";
import { fixedDevice } from "./testing/fixed-seed.ts";
import { noPins } from "./testing/no-pins.ts";

const browserPlan: VisitPlan = {
  browserArgs: [],
  browserPath: "/unused-browser",
  capabilities: { permittedCpus: 32, platform: "linux" },
  fonts: {
    evidence: undefined,
    settle: async () => {
      await Promise.resolve();
    },
  },
  identity: planIdentity({
    capabilities: { permittedCpus: 32, platform: "linux" },
    device: fixedDevice,
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: "UTC",
    mode: "headless",
    pins: noPins,
  }),
  kind: "browser",
  mode: "headless",
  url: new URL("https://example.com"),
};

const httpPlan: VisitPlan = {
  capabilities: null,
  identity: httpIdentity(noPins),
  kind: "http",
  proxy: undefined,
  url: new URL("https://example.com"),
};

describe("source capabilities", () => {
  it.each([
    { kind: "browser", plan: browserPlan },
    { kind: "http", plan: httpPlan },
  ])("refuses a released admission slot for a $kind plan without starting it", async ({ plan }) => {
    const launches: string[] = [];

    const driver: BrowserDriver = {
      launch: async () => {
        launches.push("launch");

        return await Promise.reject(new Error("Chrome must not launch."));
      },
    };

    const sources = createSources(driver);
    using deadline = startDeadline(1000);
    const held = new HeldDeadline(deadline, new AbortController().signal);
    const slot = new Slot();

    await slot[Symbol.asyncDispose]();
    const visit = sources.start(plan, slot, held);

    await expect(visit.document).rejects.toThrow("The admission slot has been released.");
    await expect(visit.closed).resolves.toStrictEqual({ exited: true });
    expect(launches).toStrictEqual([]);
    await sources.close();
  });
});
