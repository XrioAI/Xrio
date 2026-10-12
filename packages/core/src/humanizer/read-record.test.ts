import { describe, expect, it } from "vite-plus/test";

import type { DeviceRecord, HostCapabilities } from "./contracts.ts";
import { presentableRecord } from "./read-record.ts";

const capabilities: HostCapabilities = { permittedCpus: 8, platform: "linux" };

const headless = { browserArgs: [], capabilities, mode: "headless" } as const;

const stored = (record: string, platform = "linux") => ({ browserArgs: [], platform, record });

describe("read-record", () => {
  const record: DeviceRecord = {
    device: {
      cores: 8,
      fonts: { kind: "system" },
      gpu: { backend: "swiftshader", persona: null },
      memoryGb: 8,
      screen: { height: 1080, width: 1920, workArea: { bottom: 0, left: 0, right: 0, top: 0 } },
      voices: { kind: "system" },
      window: { kind: "maximized" },
    },
    policy: { locale: "en-US", timezone: { kind: "exit", zone: "America/New_York" } },
    schema: 1,
    seed: "0011223344556677",
  };

  it("reads a frozen device without changing its timezone", () => {
    expect(presentableRecord(stored(JSON.stringify(record)), headless)).toStrictEqual(record);
  });

  it.each([
    null,
    [],
    { ...record, schema: 2 },
    { ...record, seed: "0011" },
    { ...record, seed: "001122334455667788" },
    { ...record, seed: "00112233445566GG" },
    { ...record, device: { ...record.device, cores: "8" } },
    { ...record, device: { ...record.device, screen: null } },
    { ...record, policy: { ...record.policy, timezone: { kind: "exit" } } },
    { ...record, device: { ...record.device, memoryGb: Number.NaN } },
    { ...record, extra: true },
    { ...record, device: { ...record.device, extra: true } },
    {
      ...record,
      policy: { ...record.policy, timezone: { extra: true, kind: "exit", zone: "UTC" } },
    },
    { ...record, device: { ...record.device, fonts: { digest: "unexpected", kind: "system" } } },
    { ...record, device: { ...record.device, window: { kind: "maximized", x: 1 } } },
  ])("refuses an unreadable or unsupported stored record %#", (value) => {
    expect(() => presentableRecord(stored(JSON.stringify(value)), headless)).toThrow(
      expect.objectContaining({
        code: "SESSION_UNAVAILABLE",
        details: { reason: "record-refused" },
        message: "The stored device record cannot be read.",
      }),
    );
  });

  it("keeps why a readable record cannot replay and the error that said so", () => {
    const unmeasured = {
      ...record,
      policy: { ...record.policy, timezone: { kind: "exit", zone: "Mars/Olympus" } },
    };

    let refusal: unknown;

    try {
      presentableRecord(stored(JSON.stringify(unmeasured)), headless);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toMatchObject({
      cause: { name: "DeviceRecordRefusedError" },
      code: "SESSION_UNAVAILABLE",
      details: { reason: "record-refused" },
      message:
        "The stored device record cannot replay its policy: its zone Mars/Olympus is not one Chrome names.",
    });
  });

  it("refuses a scrape in the other mode than the record was made in", () => {
    const headed = { ...record, device: { ...record.device, window: { kind: "chrome-default" } } };

    expect(() =>
      presentableRecord(stored(JSON.stringify(record)), { ...headless, mode: "headed" }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_OPTIONS",
        message: "The session's device record fixes its mode.",
      }),
    );
    expect(() => presentableRecord(stored(JSON.stringify(headed)), headless)).toThrow(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
    expect(
      presentableRecord(stored(JSON.stringify(headed)), { ...headless, mode: "headed" }),
    ).toStrictEqual(headed);
  });

  it("refuses another platform and a GPU persona this host lacks", () => {
    const persona = {
      ...record,
      device: {
        ...record.device,
        gpu: { backend: "swiftshader", persona: { kind: "hide-only", name: "stored-gpu" } },
      },
    };

    const refusals = [
      stored(JSON.stringify(record), "darwin"),
      stored(JSON.stringify(persona)),
    ].map((device) => {
      try {
        return presentableRecord(device, headless);
      } catch (error) {
        return error;
      }
    });

    expect(refusals).toMatchObject([
      { code: "SESSION_UNAVAILABLE", details: { reason: "cannot-present" } },
      { code: "SESSION_UNAVAILABLE", details: { reason: "cannot-present" } },
    ]);
  });
});
