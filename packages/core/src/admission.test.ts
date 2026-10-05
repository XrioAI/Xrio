import { describe, expect, it } from "vite-plus/test";

import { createAdmission } from "./admission.ts";
import { startDeadline } from "./deadline.ts";
import { resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { manualClock } from "./testing/manual-clock.ts";

const browser = resolveScrapeIntent(
  { format: "html", url: "https://example.com" },
  resolveClientOptions({ browserPath: "/browser", mode: "headless" }),
);

describe(createAdmission, () => {
  it("rejects every queued browser visit on close and refuses later browser admissions", async () => {
    const admission = createAdmission(1);
    using request = startDeadline(1000);
    const occupied = await admission.slotFor(browser.source, request);
    const first = admission.slotFor(browser.source, request);
    const second = admission.slotFor(browser.source, request);

    admission.close();
    admission.close();
    await expect(first).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await expect(second).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await occupied[Symbol.asyncDispose]();
    await expect(admission.slotFor(browser.source, request)).rejects.toMatchObject({
      code: "CLIENT_CLOSED",
    });
    await using httpSlot = await admission.slotFor({ mode: "http" }, request);

    expect(httpSlot).toBeDefined();
  });

  it("keeps capacity until disposal, removes an aborted waiter, and admits the next", async () => {
    const admission = createAdmission(1);
    const { clock } = manualClock();
    using request = startDeadline(1000, undefined, clock);
    const slot = await admission.slotFor(browser.source, request);
    const caller = new AbortController();
    using cancelled = startDeadline(1000, caller.signal, clock);
    const reason = new Error("Cancel the queued visit.");
    const refused = admission.slotFor(browser.source, cancelled);

    caller.abort(reason);
    await expect(refused).rejects.toBe(reason);
    await slot[Symbol.asyncDispose]();
    await using next = await admission.slotFor(browser.source, request);

    expect(next).toBeDefined();
  });

  it("does not consume browser capacity for http", async () => {
    const admission = createAdmission(1);
    using request = startDeadline(1000);
    await using _browserSlot = await admission.slotFor(browser.source, request);
    await using httpSlot = await admission.slotFor({ mode: "http" }, request);

    expect(httpSlot).toBeDefined();
  });

  it("rechecks cancellation during handoff without losing the slot", async () => {
    const admission = createAdmission(1);
    const caller = new AbortController();
    using request = startDeadline(1000);
    const occupied = await admission.slotFor(browser.source, request);
    using queued = startDeadline(1000, caller.signal);
    const cancelled = admission.slotFor(browser.source, queued);

    caller.abort(new Error("Cancel before handoff."));
    await occupied[Symbol.asyncDispose]();
    await expect(cancelled).rejects.toThrow("Cancel before handoff.");
    await using successor = await admission.slotFor(browser.source, request);

    expect(successor).toBeDefined();
  });

  it("refuses a released slot that is asked to prove it is still held", async () => {
    const admission = createAdmission(1);
    using request = startDeadline(1000);
    const slot = await admission.slotFor(browser.source, request);

    slot.assertHeld();
    await slot[Symbol.asyncDispose]();
    expect(() => {
      slot.assertHeld();
    }).toThrow("The admission slot has been released.");
  });
});
