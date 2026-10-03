import { describe, expect, it } from "vite-plus/test";

import {
  deviceDigest,
  hostDigest,
  readDeviceRecord,
  DeviceRecordRefusedError,
} from "./contracts.ts";
import type { DeviceRecord, PresentedDevice } from "./contracts.ts";

const DEVICE_DIGEST = "1f6fdd787bc7b99c54582d49976c95d3011f4f912126968816c30dc7c6946ed6";

const record: DeviceRecord = {
  device: {
    cores: 8,
    fonts: { digest: "c41f09a2", kind: "stack" },
    gpu: { backend: "swiftshader", persona: "basharsx4-swiftshader-hidden" },
    memoryGb: 8,
    screen: { height: 1080, width: 1920, workArea: { bottom: 0, left: 64, right: 0, top: 32 } },
    voices: { kind: "persona", name: "basharsx4-google-linux-154" },
    window: { kind: "maximized" },
  },
  policy: { locale: "en-US", timezone: { kind: "host", zone: "Europe/Berlin" } },
  schema: 1,
  seed: "9f2c41d07a3be815",
};

const { window, ...withoutWindow } = record.device;

const { workArea, ...size } = record.device.screen;

const windowFirst: PresentedDevice = { window, ...withoutWindow, screen: { workArea, ...size } };

describe(deviceDigest, () => {
  it("hashes the canonical JSON of the device", () => {
    expect(deviceDigest(record)).toBe(DEVICE_DIGEST);
  });

  it("ignores key order", () => {
    expect(Object.keys(windowFirst)[0]).toBe("window");
    expect(Object.keys(windowFirst.screen)[0]).toBe("workArea");
    expect(deviceDigest({ ...record, device: windowFirst })).toBe(DEVICE_DIGEST);
  });

  it("ignores the policy, so a policy change never looks like a device change", () => {
    expect(
      deviceDigest({
        ...record,
        policy: { locale: "de-DE", timezone: { kind: "pinned", zone: "America/New_York" } },
      }),
    ).toBe(DEVICE_DIGEST);
  });

  it("changes with the device", () => {
    expect(deviceDigest({ ...record, device: { ...record.device, cores: 4 } })).not.toBe(
      DEVICE_DIGEST,
    );
  });
});

describe(hostDigest, () => {
  it("hashes the canonical JSON of the host capabilities", () => {
    expect(hostDigest({ platform: "linux" })).toBe(
      "a0bda0c198f101a78089a967aeea62b5b2250dc77f0f96a254078494e9af9831",
    );
  });
});

const refusalOf = (stored: string) => {
  try {
    return { record: readDeviceRecord(stored) };
  } catch (error) {
    return error instanceof DeviceRecordRefusedError
      ? { message: error.message, refusal: error.refusal }
      : { error };
  }
};

describe(readDeviceRecord, () => {
  it("reads a stored schema 1 record", () => {
    expect(readDeviceRecord(JSON.stringify(record))).toStrictEqual(record);
  });

  it.each([
    {
      message: "Device record field seed is malformed.",
      refusal: { field: "seed", kind: "malformed" },
      stored: '{"schema":1}',
    },
    {
      message: "Device record field seed is malformed.",
      refusal: { field: "seed", kind: "malformed" },
      stored: '{"schema":1,"seed":7,"device":{"cores":"many"},"policy":null}',
    },
    {
      message: "Device record field schema is malformed.",
      refusal: { field: "schema", kind: "malformed" },
      stored: '{"schema":"1"}',
    },
    {
      message: "Device record schema 2 is unknown; Xrio reads schema 1 only.",
      refusal: { kind: "unknown-schema", schema: 2 },
      stored: '{"schema":2}',
    },
    {
      message: "Device record field record is malformed.",
      refusal: { field: "record", kind: "malformed" },
      stored: "not json",
    },
    {
      message: "Device record field record is malformed.",
      refusal: { field: "record", kind: "malformed" },
      stored: "[]",
    },
    {
      message: "Device record field device is malformed.",
      refusal: { field: "device", kind: "malformed" },
      stored: JSON.stringify({ ...record, device: { ...record.device, cores: "many" } }),
    },
    {
      message: "Device record field policy is malformed.",
      refusal: { field: "policy", kind: "malformed" },
      stored: JSON.stringify({ ...record, policy: null }),
    },
  ])("refuses $stored with a typed error", ({ message, refusal, stored }) => {
    expect(refusalOf(stored)).toStrictEqual({ message, refusal });
  });

  it.each([
    {
      name: "a native GPU, the default window, system fonts and voices, and an exit zone",
      stored: {
        ...record,
        device: {
          ...record.device,
          fonts: { kind: "system" },
          gpu: { backend: "native" },
          voices: { kind: "system" },
          window: { kind: "chrome-default" },
        },
        policy: { locale: "en-US", timezone: { kind: "exit" } },
      },
    },
    {
      name: "a SwiftShader GPU without a persona",
      stored: {
        ...record,
        device: { ...record.device, gpu: { backend: "swiftshader", persona: null } },
      },
    },
    {
      name: "a floating window and a pinned zone",
      stored: {
        ...record,
        device: {
          ...record.device,
          window: { height: 900, kind: "floating", width: 1400, x: 10, y: 40 },
        },
        policy: { locale: "de-DE", timezone: { kind: "pinned", zone: "Europe/Berlin" } },
      },
    },
  ])("reads $name", ({ stored }) => {
    expect(readDeviceRecord(JSON.stringify(stored))).toStrictEqual(stored);
  });

  const { device, policy } = record;

  it.each([
    { field: "record", name: "an extra top-level key", stored: { ...record, extra: 1 } },
    {
      field: "device",
      name: "an extra device key",
      stored: { ...record, device: { ...record.device, extra: 1 } },
    },
    {
      field: "device",
      name: "a native GPU with a persona",
      stored: { ...record, device: { ...record.device, gpu: { backend: "native", persona: "x" } } },
    },
    {
      field: "device",
      name: "a maximized window with a width",
      stored: { ...record, device: { ...record.device, window: { kind: "maximized", width: 5 } } },
    },
    {
      field: "device",
      name: "an extra work-area key",
      stored: {
        ...record,
        device: {
          ...record.device,
          screen: {
            ...record.device.screen,
            workArea: { ...record.device.screen.workArea, extra: 1 },
          },
        },
      },
    },
    {
      field: "policy",
      name: "an exit zone policy with a zone",
      stored: { ...record, policy: { locale: "en-US", timezone: { kind: "exit", zone: "X" } } },
    },
    {
      field: "policy",
      name: "an extra policy key",
      stored: { ...record, policy: { ...record.policy, extra: 1 } },
    },
    {
      field: "device",
      name: "an extra screen key",
      stored: { ...record, device: { ...device, screen: { ...device.screen, extra: 1 } } },
    },
    {
      field: "device",
      name: "an extra floating-window key",
      stored: {
        ...record,
        device: {
          ...device,
          window: { extra: 1, height: 900, kind: "floating", width: 1400, x: 10, y: 40 },
        },
      },
    },
    {
      field: "device",
      name: "an extra SwiftShader key",
      stored: {
        ...record,
        device: { ...device, gpu: { backend: "swiftshader", extra: 1, persona: null } },
      },
    },
    {
      field: "device",
      name: "an extra system-fonts key",
      stored: { ...record, device: { ...device, fonts: { extra: 1, kind: "system" } } },
    },
    {
      field: "device",
      name: "an extra font-stack key",
      stored: {
        ...record,
        device: { ...device, fonts: { digest: "c41f09a2", extra: 1, kind: "stack" } },
      },
    },
    {
      field: "device",
      name: "an extra system-voices key",
      stored: { ...record, device: { ...device, voices: { extra: 1, kind: "system" } } },
    },
    {
      field: "device",
      name: "an extra voice-persona key",
      stored: {
        ...record,
        device: {
          ...device,
          voices: { extra: 1, kind: "persona", name: "basharsx4-google-linux-154" },
        },
      },
    },
    {
      field: "policy",
      name: "an extra zone key",
      stored: {
        ...record,
        policy: { ...policy, timezone: { extra: 1, kind: "pinned", zone: "Europe/Berlin" } },
      },
    },
    { field: "seed", name: "an uppercase seed", stored: { ...record, seed: "9F2C41D07A3BE815" } },
    { field: "seed", name: "a 15-digit seed", stored: { ...record, seed: "9f2c41d07a3be81" } },
    {
      field: "device",
      name: "a screen width that is not a number",
      stored: { ...record, device: { ...device, screen: { ...device.screen, width: "wide" } } },
    },
    {
      field: "device",
      name: "a negative work-area inset",
      stored: {
        ...record,
        device: {
          ...device,
          screen: { ...device.screen, workArea: { ...device.screen.workArea, top: -1 } },
        },
      },
    },
    {
      field: "device",
      name: "an unknown window kind",
      stored: { ...record, device: { ...device, window: { kind: "minimized" } } },
    },
    {
      field: "device",
      name: "a floating window without y",
      stored: {
        ...record,
        device: { ...device, window: { height: 900, kind: "floating", width: 1400, x: 10 } },
      },
    },
    {
      field: "device",
      name: "a floating window with a negative y",
      stored: {
        ...record,
        device: { ...device, window: { height: 900, kind: "floating", width: 1400, x: 10, y: -1 } },
      },
    },
    {
      field: "device",
      name: "cores that are not a number",
      stored: { ...record, device: { ...device, cores: "many" } },
    },
    {
      field: "device",
      name: "negative memory",
      stored: { ...record, device: { ...device, memoryGb: -1 } },
    },
    {
      field: "device",
      name: "an unknown GPU backend",
      stored: { ...record, device: { ...device, gpu: { backend: "metal" } } },
    },
    {
      field: "device",
      name: "a SwiftShader persona that is not text",
      stored: { ...record, device: { ...device, gpu: { backend: "swiftshader", persona: 7 } } },
    },
    {
      field: "device",
      name: "a font stack without a digest",
      stored: { ...record, device: { ...device, fonts: { kind: "stack" } } },
    },
    {
      field: "device",
      name: "an unknown font kind",
      stored: { ...record, device: { ...device, fonts: { kind: "web" } } },
    },
    {
      field: "device",
      name: "a voice persona name that is not text",
      stored: { ...record, device: { ...device, voices: { kind: "persona", name: 7 } } },
    },
    {
      field: "device",
      name: "an unknown voices kind",
      stored: { ...record, device: { ...device, voices: { kind: "robot" } } },
    },
    {
      field: "policy",
      name: "a locale that is not text",
      stored: { ...record, policy: { ...policy, locale: 5 } },
    },
    {
      field: "policy",
      name: "a pinned zone without a zone",
      stored: { ...record, policy: { ...policy, timezone: { kind: "pinned" } } },
    },
    {
      field: "policy",
      name: "a host zone that is not text",
      stored: { ...record, policy: { ...policy, timezone: { kind: "host", zone: 7 } } },
    },
    {
      field: "policy",
      name: "an unknown timezone kind",
      stored: { ...record, policy: { ...policy, timezone: { kind: "moon", zone: "UTC" } } },
    },
  ])("refuses a record with $name as a malformed $field", ({ field, stored }) => {
    expect(refusalOf(JSON.stringify(stored))).toStrictEqual({
      message: `Device record field ${field} is malformed.`,
      refusal: { field, kind: "malformed" },
    });
  });
});
