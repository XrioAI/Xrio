import { describe, expect, it } from "vite-plus/test";

import { deviceDigest, hostDigest, refuseUnreplayable } from "./contracts.ts";
import type { DeviceRecord, ForkFacts, FontStackFacts, PresentedDevice } from "./contracts.ts";

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

const STACK: FontStackFacts = {
  cacheDir: "/tmp/xrio-501/fontcache-0123456789abcdef",
  directory: "/opt/xrio-chrome/fontstack",
  families: 175,
  kind: "checked",
  payload: "62bbc5617946311ab21ed9ec8ef22f68a15e4ccf06cebf01aca807fedb1def3d",
  rules: ["10-antialias.conf", "60-latin.conf"],
};

const HOST_WITH_STACK = "4b3efd7a8fde068a0ec642f1738c86671da37d249ba422a33ed2a8c2db2dcce5";

const FORK: ForkFacts = {
  buildUnreadable: false,
  commit: null,
  dialect: "xrio",
  dirty: null,
  knobs: {},
  packageDir: "/opt/xrio-chrome",
  personas: { speech: [] },
  version: "154.0.8037.57",
};

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe(hostDigest, () => {
  it("hashes the canonical JSON of the host capabilities", () => {
    expect(hostDigest({ permittedCpus: 32, platform: "linux" })).toBe(
      "552ef7a2d12ce590b366a06f4d069fdb8a62f7a08aa8fa0be33011854f612c9c",
    );
  });

  it("gives hosts that permit other CPUs other digests, because they present other hardware", () => {
    const digests = [32, 6].map((permittedCpus) =>
      hostDigest({ permittedCpus, platform: "linux" }),
    );

    expect(new Set(digests).size).toBe(2);
  });

  it("names a checked font stack by its content, wherever it and its cache live", () => {
    const moved = {
      ...STACK,
      cacheDir: "/tmp/xrio-1002/fontcache-fedcba9876543210",
      directory: "/home/b/xrio-chrome/fontstack",
    };

    expect(
      [STACK, moved].map((fontStack) =>
        hostDigest({ fontStack, permittedCpus: 32, platform: "linux" }),
      ),
    ).toStrictEqual([HOST_WITH_STACK, HOST_WITH_STACK]);
  });

  it("gives two builds of one fork package two digests, and an unrecorded build a third", () => {
    const hosts = [
      FORK,
      { ...FORK, commit: COMMIT, dirty: 0 },
      { ...FORK, commit: COMMIT, dirty: 2 },
      { ...FORK, commit: "fedcba9876543210fedcba9876543210fedcba98", dirty: 0 },
      { ...FORK, buildUnreadable: true },
    ].map((fork) => hostDigest({ fork, permittedCpus: 32, platform: "linux" }));

    expect(hosts).toStrictEqual([
      "cd2978d6ab4db4a257ee232d8d2b7fd6543b7702a09bf972691354600f33f78f",
      "bcb7b6a17c82dbb2998924e123ac25ec30016ef576d5980614501fdc96ba0db9",
      "c763a12297711f8436a3bd74f02b386da7af556b25d668b3c820320ca40411c9",
      "b07cb85ae1e5da77f3f626dff7dfbcc6dbb2aa263c8505d7caaa7a41476e4f19",
      "b13c969f40a474cca7dbd3f2e243337596f677da1c51cbc0b050c4fc7150e81a",
    ]);
  });

  it("leaves font evidence out, so the gathering scrape and later ones share the digest", () => {
    expect(
      [1000, 2000].map((ageMs) =>
        hostDigest({
          fontEvidence: {
            ageMs,
            digest: "c41f09a2",
            key: "0123456789abcdef",
            sentinel: "5e17a1b2",
          },
          fontStack: STACK,
          permittedCpus: 32,
          platform: "linux",
        }),
      ),
    ).toStrictEqual([HOST_WITH_STACK, HOST_WITH_STACK]);
  });
});

const refusalOf = (stored: DeviceRecord) => {
  try {
    refuseUnreplayable(stored);
  } catch (error) {
    if (error instanceof Error && "refusal" in error) {
      return { message: error.message, refusal: error.refusal };
    }

    throw error;
  }

  throw new Error("The record replays.");
};

const withDevice = (device: Partial<PresentedDevice>): DeviceRecord => ({
  ...record,
  device: { ...record.device, ...device },
});

describe("a stored record that cannot replay", () => {
  it.each([
    {
      field: "device",
      reason:
        "its 1300x800 window at 5000,4000 is not a whole-pixel window inside its screen's work area",
      stored: withDevice({
        window: { height: 800, kind: "floating", width: 1300, x: 5000, y: 4000 },
      }),
    },
    {
      field: "device",
      reason: "its screen 0x0 is not a size in whole pixels",
      stored: withDevice({
        screen: { height: 0, width: 0, workArea: { bottom: 0, left: 0, right: 0, top: 0 } },
      }),
    },
    {
      field: "device",
      reason: "its screen 1920.5x1080 is not a size in whole pixels",
      stored: withDevice({ screen: { ...record.device.screen, width: 1920.5 } }),
    },
    {
      field: "device",
      reason: "its screen's work area insets are not whole pixels",
      stored: withDevice({
        screen: { ...record.device.screen, workArea: { bottom: 0.5, left: 0, right: 0, top: 0 } },
      }),
    },
    {
      field: "device",
      reason: "its screen's 1856x40 work area is under Chrome's 500x88 px minimum window",
      stored: withDevice({
        screen: {
          ...record.device.screen,
          workArea: { bottom: 1008, left: 64, right: 0, top: 32 },
        },
      }),
    },
    {
      field: "device",
      reason:
        "its 1300x50 window at 100,100 is not a whole-pixel window inside its screen's work area",
      stored: withDevice({ window: { height: 50, kind: "floating", width: 1300, x: 100, y: 100 } }),
    },
    {
      field: "policy",
      reason: "Xrio has not measured Chrome's language list for its locale xx-XX",
      stored: { ...record, policy: { ...record.policy, locale: "xx-XX" } },
    },
    {
      field: "policy",
      reason: "its zone Mars/Olympus is not one Chrome names",
      stored: {
        ...record,
        policy: { locale: "en-US", timezone: { kind: "pinned", zone: "Mars/Olympus" } },
      } satisfies DeviceRecord,
    },
  ])("is refused because $reason", ({ field, reason, stored }) => {
    expect(refusalOf(stored)).toStrictEqual({
      message: `Device record cannot replay: ${reason}.`,
      refusal: { field, kind: "unreplayable", reason },
    });
  });
});
