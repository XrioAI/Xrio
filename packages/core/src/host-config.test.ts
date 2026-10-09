import { describe, expect, it } from "vite-plus/test";

import { resolveHostConfig } from "./host-config.ts";

const refusal = (message: string) => ({ code: "INVALID_OPTIONS", message, name: "TypeError" });

const identityOf = (...host: Parameters<typeof resolveHostConfig>) =>
  resolveHostConfig(...host).identity;

describe("the host section", () => {
  it("is empty when the config sets no host", () => {
    expect(resolveHostConfig()).toStrictEqual({
      browserArgs: undefined,
      identity: { display: undefined, hardware: undefined, locale: undefined, timezone: undefined },
    });
    expect(resolveHostConfig({})).toStrictEqual(resolveHostConfig());
  });

  it("resolves every field of a complete section", () => {
    expect(
      resolveHostConfig({
        browserArgs: ["--no-sandbox"],
        display: { screen: { height: 1080, width: 1920 }, taskbar: { bottom: 48 } },
        hardware: { cores: 8, gpuPolicy: "matched", memoryGb: 16 },
        locale: "de-DE",
        timezone: "Europe/Berlin",
      }),
    ).toStrictEqual({
      browserArgs: ["--no-sandbox"],
      identity: {
        display: {
          screens: [{ height: 1080, weight: 1, width: 1920 }],
          taskbars: [{ bottom: 48, left: 0, right: 0, top: 0, weight: 1 }],
          windows: undefined,
        },
        hardware: {
          cores: [{ value: 8, weight: 1 }],
          gpu: undefined,
          gpuPolicy: "matched",
          memoryGb: [{ value: 16, weight: 1 }],
        },
        locale: "de-DE",
        timezone: "Europe/Berlin",
      },
    });
  });

  it.each([
    { host: { dpr: 2 }, name: "an unknown field" },
    { host: null, name: "null" },
    { host: [], name: "an array" },
    { host: "de-DE", name: "a string" },
  ])("refuses $name", ({ host }) => {
    expect(() => resolveHostConfig(host)).toThrow(
      expect.objectContaining(
        refusal("host takes locale, timezone, display, hardware and browserArgs."),
      ),
    );
  });
});

describe("host.locale", () => {
  const posixLocale = refusal(
    "host.locale must be a BCP 47 language tag such as de-DE, not a POSIX locale such as en_US.UTF-8.",
  );

  const malformedLocale = refusal("host.locale must be one BCP 47 language tag such as de-DE.");

  it("reads a locale written as a getter", () => {
    const host = {
      get locale() {
        return "de-DE";
      },
    };

    expect(identityOf(host).locale).toBe("de-DE");
  });

  it.each(["de-DE", "en-AU", "pt-BR"])("takes the canonical tag %s", (locale) => {
    expect(identityOf({ locale }).locale).toBe(locale);
  });

  it.each([
    { given: "de-de", tag: "de-DE" },
    { given: "EN-au", tag: "en-AU" },
    { given: "PT-BR", tag: "pt-BR" },
  ])("refuses $given and names its canonical spelling $tag", ({ given, tag }) => {
    expect(() => resolveHostConfig({ locale: given })).toThrow(
      expect.objectContaining(refusal(`host.locale ${given} is spelled ${tag}.`)),
    );
  });

  it("leaves the locale unpinned until the config pins one", () => {
    expect(identityOf({}).locale).toBeUndefined();
  });

  it.each(["en_US.UTF-8", "en_US", "de_DE@euro", "C.UTF-8"])(
    "refuses the POSIX form %j with the POSIX message",
    (locale) => {
      expect(() => resolveHostConfig({ locale })).toThrow(expect.objectContaining(posixLocale));
    },
  );

  it.each(["", "de-DE,fr-FR", "en-US ", " de-DE", "C", "de-", 5, null, {}])(
    "refuses the malformed form %j with the BCP 47 message",
    (locale) => {
      expect(() => resolveHostConfig({ locale })).toThrow(expect.objectContaining(malformedLocale));
    },
  );

  it.each([
    {
      locale: "de",
      message:
        "host.locale de is not one Xrio has measured Chrome's language list for. Try de-AT, de-CH, or de-DE.",
    },
    {
      locale: "ja-JP-u-ca-japanese",
      message:
        "host.locale ja-JP-u-ca-japanese is not one Xrio has measured Chrome's language list for. Try ja-JP.",
    },
    {
      locale: "zh-Hant-TW",
      message:
        "host.locale zh-Hant-TW is not one Xrio has measured Chrome's language list for. Try zh-CN, zh-HK, or zh-TW.",
    },
    {
      locale: "sw-KE",
      message: "host.locale sw-KE is not one Xrio has measured Chrome's language list for.",
    },
  ])(
    "refuses the unmeasured tag $locale and names the measured tags of its language",
    ({ locale, message }) => {
      expect(() => resolveHostConfig({ locale })).toThrow(
        expect.objectContaining(refusal(message)),
      );
    },
  );
});

describe("host.timezone", () => {
  const invalidZone = refusal("host.timezone must be an IANA zone name such as America/New_York.");

  it.each([
    ["UTC", "UTC"],
    ["Europe/Kyiv", "Europe/Kiev"],
    ["Asia/Kolkata", "Asia/Calcutta"],
    ["america/chicago", "America/Chicago"],
  ])("accepts %s and resolves it to %s", (timezone, zone) => {
    expect(identityOf({ timezone }).timezone).toBe(zone);
  });

  it("defaults to no zone", () => {
    expect(identityOf({}).timezone).toBeUndefined();
  });

  it.each(["Mars/Olympus", "", " UTC", "Etc/Unknown", "+05:30", "-08:00", "GMT+5", 5, null, {}])(
    "refuses the zone %j",
    (timezone) => {
      expect(() => resolveHostConfig({ timezone })).toThrow(expect.objectContaining(invalidZone));
    },
  );
});

describe("host.browserArgs", () => {
  it("keeps the switches in order, as a frozen copy the caller cannot change", () => {
    const browserArgs = [
      "--no-sandbox",
      "--disable-gpu-compositing",
      "--disk-cache-dir=/tmp/cache dir",
    ];

    const { browserArgs: resolved } = resolveHostConfig({ browserArgs });

    browserArgs.push("--lang=fr");

    expect(resolved).toStrictEqual([
      "--no-sandbox",
      "--disable-gpu-compositing",
      "--disk-cache-dir=/tmp/cache dir",
    ]);
    expect(Object.isFrozen(resolved)).toBeTruthy();
  });

  it("is absent when the config sets none, and empty when it sets an empty list", () => {
    expect(resolveHostConfig({}).browserArgs).toBeUndefined();
    expect(resolveHostConfig({ browserArgs: [] }).browserArgs).toStrictEqual([]);
  });

  it.each([
    { entry: 1, value: ["--ok", 42] },
    { entry: 0, value: [""] },
    { entry: 0, value: ["no-sandbox"] },
    { entry: 0, value: ["--two words"] },
    { entry: 1, value: ["--ok", "secret"] },
    { entry: 1, value: ["--ok", undefined] },
  ])("refuses the malformed entry in $value and names only its position", ({ entry, value }) => {
    expect(() => resolveHostConfig({ browserArgs: value })).toThrow(
      expect.objectContaining(
        refusal(`host.browserArgs entry ${entry} must be a switch such as --name or --name=value.`),
      ),
    );
  });

  it("names host.browserArgs when the config lists a switch Xrio manages", () => {
    expect(() => resolveHostConfig({ browserArgs: ["--lang=fr"] })).toThrow(
      expect.objectContaining(
        refusal("host.browserArgs cannot include --lang, which Xrio manages."),
      ),
    );
  });

  it.each(["--lang=fr", "--user-data-dir=/tmp/x", "--proxy-server=http://user:secret@proxy.test"])(
    "refuses %s and names the switch without its value",
    (entry) => {
      const [name] = entry.split("=", 1);

      expect(() => resolveHostConfig({ browserArgs: ["--no-sandbox", entry] })).toThrow(
        expect.objectContaining(
          refusal(`host.browserArgs cannot include ${name}, which Xrio manages.`),
        ),
      );
    },
  );

  it("accepts a valueless switch Xrio's baseline already sets and sends it once", () => {
    expect(
      resolveHostConfig({
        browserArgs: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu-compositing"],
      }).browserArgs,
    ).toStrictEqual(["--no-sandbox", "--disable-gpu-compositing"]);
  });

  it.each(["--no-sandbox", { 0: "--no-sandbox", length: 1 }, null])(
    "refuses %j, which is not an array",
    (browserArgs) => {
      expect(() => resolveHostConfig({ browserArgs })).toThrow(
        expect.objectContaining(refusal("host.browserArgs must be an array of strings.")),
      );
    },
  );
});

describe("host.display", () => {
  it("turns single values into one-row tables and leaves the rest to the draw", () => {
    expect(
      identityOf({
        display: {
          screen: { height: 900, width: 1440 },
          taskbar: { bottom: 48 },
          window: "maximized",
        },
      }).display,
    ).toStrictEqual({
      screens: [{ height: 900, weight: 1, width: 1440 }],
      taskbars: [{ bottom: 48, left: 0, right: 0, top: 0, weight: 1 }],
      windows: [{ kind: "maximized", weight: 1 }],
    });
    expect(identityOf({ display: { taskbar: {} } }).display).toStrictEqual({
      screens: undefined,
      taskbars: [{ bottom: 0, left: 0, right: 0, top: 0, weight: 1 }],
      windows: undefined,
    });
    expect(identityOf({}).display).toBeUndefined();
  });

  it("keeps weighted tables, sized windows and their positions", () => {
    expect(
      identityOf({
        display: {
          screen: [
            { height: 1080, weight: 40, width: 1920 },
            { height: 1440, weight: 7, width: 2560 },
          ],
          taskbar: [
            { left: 64, top: 32, weight: 3 },
            { bottom: 48, weight: 2 },
          ],
          window: [
            { maximized: true, weight: 4 },
            { height: 800, weight: 1, width: 1280 },
            { height: 700, weight: 1, width: 1300, x: 100, y: 120 },
          ],
        },
      }).display,
    ).toStrictEqual({
      screens: [
        { height: 1080, weight: 40, width: 1920 },
        { height: 1440, weight: 7, width: 2560 },
      ],
      taskbars: [
        { bottom: 0, left: 64, right: 0, top: 32, weight: 3 },
        { bottom: 48, left: 0, right: 0, top: 0, weight: 2 },
      ],
      windows: [
        { kind: "maximized", weight: 4 },
        { height: 800, kind: "sized", weight: 1, width: 1280 },
        { height: 700, kind: "sized", position: { x: 100, y: 120 }, weight: 1, width: 1300 },
      ],
    });
  });

  it.each([
    {
      display: { screen: { height: 900, width: 1440 }, window: { height: 900, width: 1440 } },
      message:
        "host.display window 1440x900 at 0,32 does not fit the 1440x868 work area at 0,32 of a 1440x900 screen.",
      name: "a window taller than the work area under a drawn top bar",
    },
    {
      display: {
        screen: { height: 900, width: 1440 },
        taskbar: { top: 32 },
        window: { height: 800, width: 1200, x: 300, y: 10 },
      },
      message:
        "host.display window 1200x800 at 300,10 does not fit the 1440x868 work area at 0,32 of a 1440x900 screen.",
      name: "a window placed over the top bar",
    },
    {
      display: { screen: { height: 900, width: 1440 }, window: { height: 600, width: 499 } },
      message:
        "host.display leaves a 499x600 window in the 1440x868 work area at 0,32 of a 1440x900 screen, under Chrome's 500x88 px minimum window.",
      name: "a window under Chrome's minimum width",
    },
    {
      display: { screen: { height: 600, width: 800 }, taskbar: { left: 400 } },
      message:
        "host.display leaves a 400x600 window in the 400x600 work area at 400,0 of a 800x600 screen, under Chrome's 500x88 px minimum window.",
      name: "a taskbar that leaves a maximized window under the minimum",
    },
    {
      display: {
        screen: { height: 900, width: 1440 },
        taskbar: {},
        window: { height: 50, width: 600, x: 0, y: 0 },
      },
      message:
        "host.display leaves a 600x50 window in the 1440x900 work area at 0,0 of a 1440x900 screen, under Chrome's 500x88 px minimum window.",
      name: "a window shorter than Chrome's minimum height",
    },
    {
      display: { screen: { height: 900, width: 1440 }, taskbar: { top: 820 }, window: "maximized" },
      message:
        "host.display leaves a 1440x80 window in the 1440x80 work area at 0,820 of a 1440x900 screen, under Chrome's 500x88 px minimum window.",
      name: "a taskbar that leaves a maximized window under the minimum height",
    },
    {
      display: { window: { height: 1000, width: 1700 } },
      message:
        "host.display window 1700x1000 at 0,32 does not fit the 1366x736 work area at 0,32 of a 1366x768 screen.",
      name: "a window that does not fit one of Xrio's screens",
    },
  ])("refuses $name", ({ display, message }) => {
    expect(() => resolveHostConfig({ display })).toThrow(expect.objectContaining(refusal(message)));
  });

  it("treats an undefined weight on a single value as absent", () => {
    expect(
      identityOf({ display: { taskbar: { bottom: 48, weight: undefined } } }).display?.taskbars,
    ).toStrictEqual([{ bottom: 48, left: 0, right: 0, top: 0, weight: 1 }]);
  });

  it("refuses a null taskbar edge instead of reading it as 0", () => {
    expect(() => resolveHostConfig({ display: { taskbar: { bottom: null } } })).toThrow(
      expect.objectContaining(
        refusal(
          "host.display.taskbar takes top, right, bottom and left insets in whole pixels, such as { bottom: 48 }.",
        ),
      ),
    );
  });

  it("accepts a window at exactly Chrome's 500x88 px minimum", () => {
    expect(
      identityOf({
        display: {
          screen: { height: 900, width: 1440 },
          taskbar: {},
          window: { height: 88, width: 500 },
        },
      }).display?.windows,
    ).toStrictEqual([{ height: 88, kind: "sized", weight: 1, width: 500 }]);
  });

  it.each([
    {
      display: { screen: { height: 900, width: 0 } },
      message:
        "host.display.screen takes a width and a height in whole pixels, such as { width: 1440, height: 900 }.",
    },
    {
      display: { screen: { height: 900.5, width: 1440 } },
      message:
        "host.display.screen takes a width and a height in whole pixels, such as { width: 1440, height: 900 }.",
    },
    {
      display: { screen: [] },
      message: "host.display.screen must be a value or a non-empty weighted table.",
    },
    {
      display: { screen: [{ height: 900, weight: 0, width: 1440 }] },
      message: "host.display.screen weights must be positive numbers.",
    },
    {
      display: { taskbar: { bottom: -1 } },
      message:
        "host.display.taskbar takes top, right, bottom and left insets in whole pixels, such as { bottom: 48 }.",
    },
    {
      display: { screen: { dpr: 2, height: 900, width: 1440 } },
      message:
        "host.display.screen takes a width and a height in whole pixels, such as { width: 1440, height: 900 }.",
    },
    {
      display: { window: { height: 800, left: 10, width: 1200 } },
      message:
        "host.display.window takes a width and a height in whole pixels, with an optional x and y.",
    },
    {
      display: { taskbar: { height: 40 } },
      message:
        "host.display.taskbar takes top, right, bottom and left insets in whole pixels, such as { bottom: 48 }.",
    },
    {
      display: { window: { height: 800, width: 1200, x: 10 } },
      message: "host.display.window x and y must be given together, as whole pixels.",
    },
    {
      display: { window: "fullscreen" },
      message: "host.display.window must be a value or a non-empty weighted table.",
    },
    { display: { dpr: 2 }, message: "host.display takes screen, taskbar and window." },
    {
      display: { window: [{ height: 600, maximized: true, weight: 1, width: 900 }] },
      message:
        "host.display.window rows that maximize take only { maximized: true, weight }, with no size.",
    },
    {
      display: { window: [{ maximized: true, typo: 1, weight: 1 }] },
      message:
        "host.display.window rows that maximize take only { maximized: true, weight }, with no size.",
    },
    {
      display: { window: [{ maximized: "no", weight: 1 }] },
      message:
        "host.display.window rows that maximize take only { maximized: true, weight }, with no size.",
    },
    {
      display: {
        screen: [
          { height: 1080, weight: 1e308, width: 1920 },
          { height: 900, weight: 1e308, width: 1440 },
        ],
      },
      message: "host.display.screen weights must add up to a finite number.",
    },
    { display: null, message: "host.display takes screen, taskbar and window." },
    {
      display: { screen: { height: 900, weight: 2, width: 1440 } },
      message: "host.display.screen weight applies only to rows of a weighted table.",
    },
    {
      display: { taskbar: { bottom: 48, weight: 2 } },
      message: "host.display.taskbar weight applies only to rows of a weighted table.",
    },
    {
      display: { window: { maximized: true, weight: 2 } },
      message: "host.display.window weight applies only to rows of a weighted table.",
    },
    {
      display: { window: { maximized: true } },
      message:
        'A single maximized host.display.window is written "maximized"; { maximized: true } is only for rows of a weighted table.',
    },
  ])("refuses the malformed display $display", ({ display, message }) => {
    expect(() => resolveHostConfig({ display })).toThrow(expect.objectContaining(refusal(message)));
  });
});

describe("host.hardware", () => {
  const coresMessage =
    "host.hardware.cores must be a positive whole number of at most 2147483647, or a weighted table of them.";

  const gpuMessage =
    "host.hardware.gpu must be a GL persona name, or a non-empty weighted table of them.";

  it("turns single values into one-row tables and leaves the rest to the draw", () => {
    expect(identityOf({ hardware: { cores: 8, memoryGb: 16 } }).hardware).toStrictEqual({
      cores: [{ value: 8, weight: 1 }],
      gpu: undefined,
      gpuPolicy: undefined,
      memoryGb: [{ value: 16, weight: 1 }],
    });
    expect(identityOf({ hardware: { memoryGb: 32 } }).hardware).toStrictEqual({
      cores: undefined,
      gpu: undefined,
      gpuPolicy: undefined,
      memoryGb: [{ value: 32, weight: 1 }],
    });
    expect(identityOf({}).hardware).toBeUndefined();
  });

  it("keeps weighted tables in order", () => {
    expect(
      identityOf({
        hardware: {
          cores: [
            { value: 8, weight: 3 },
            { value: 12, weight: 1 },
          ],
          memoryGb: [
            { value: 8, weight: 1 },
            { value: 32, weight: 2 },
          ],
        },
      }).hardware,
    ).toStrictEqual({
      cores: [
        { value: 8, weight: 3 },
        { value: 12, weight: 1 },
      ],
      gpu: undefined,
      gpuPolicy: undefined,
      memoryGb: [
        { value: 8, weight: 1 },
        { value: 32, weight: 2 },
      ],
    });
  });

  it.each([
    { hardware: { cores: 0 }, name: "zero cores" },
    { hardware: { cores: -4 }, name: "negative cores" },
    { hardware: { cores: 6.5 }, name: "fractional cores" },
    { hardware: { cores: Number.NaN }, name: "NaN cores" },
    { hardware: { cores: Number.POSITIVE_INFINITY }, name: "infinite cores" },
    { hardware: { cores: 2_147_483_648 }, name: "more cores than the fork accepts" },
    { hardware: { cores: "8" }, name: "cores as text" },
    {
      hardware: {
        cores: [
          { value: 8, weight: 1 },
          { value: 0, weight: 1 },
        ],
      },
      name: "a zero row",
    },
  ])("refuses $name", ({ hardware }) => {
    expect(() => resolveHostConfig({ hardware })).toThrow(
      expect.objectContaining(refusal(coresMessage)),
    );
  });

  it.each([1, 3, 6, 12, 24, 64, 0, -8, 8.5, Number.NaN])("refuses %s GB of memory", (memoryGb) => {
    expect(() => resolveHostConfig({ hardware: { memoryGb } })).toThrow(
      expect.objectContaining(
        refusal(
          "host.hardware.memoryGb must be 2, 4, 8, 16 or 32 GB, or a weighted table of them.",
        ),
      ),
    );
  });

  it.each([2, 4, 8, 16, 32])("accepts %s GB of memory", (memoryGb) => {
    expect(identityOf({ hardware: { memoryGb } }).hardware?.memoryGb).toStrictEqual([
      { value: memoryGb, weight: 1 },
    ]);
  });

  it.each([
    {
      hardware: { cores: [] },
      message: "host.hardware.cores must be a value or a non-empty weighted table.",
    },
    {
      hardware: { cores: [{ value: 8, weight: 0 }] },
      message: "host.hardware.cores weights must be positive numbers.",
    },
    {
      hardware: {
        memoryGb: [
          { value: 8, weight: 1e308 },
          { value: 16, weight: 1e308 },
        ],
      },
      message: "host.hardware.memoryGb weights must add up to a finite number.",
    },
    {
      hardware: { cores: [{ typo: 1, value: 8, weight: 1 }] },
      message: "host.hardware.cores rows take only a value and a weight.",
    },
    {
      hardware: { memoryGb: [{ typo: 1, value: 8, weight: 1 }] },
      message: "host.hardware.memoryGb rows take only a value and a weight.",
    },
    { hardware: { cores: { value: 8 } }, message: coresMessage },
    { hardware: { cores: { value: 8, weight: 2 } }, message: coresMessage },
    { hardware: { gpu: [] }, message: gpuMessage },
    {
      hardware: { gpu: [{ name: "basharsx4-amd-renoir", weight: 0 }] },
      message: "host.hardware.gpu weights must be positive numbers.",
    },
    {
      hardware: { threads: 8 },
      message: "host.hardware takes cores, memoryGb, gpu and gpuPolicy.",
    },
    { hardware: null, message: "host.hardware takes cores, memoryGb, gpu and gpuPolicy." },
  ])("refuses the malformed hardware $hardware", ({ hardware, message }) => {
    expect(() => resolveHostConfig({ hardware })).toThrow(
      expect.objectContaining(refusal(message)),
    );
  });

  it("turns a GL persona name into a one-row table and keeps a weighted table in order", () => {
    expect([
      identityOf({ hardware: { gpu: "basharsx4-amd-renoir" } }).hardware?.gpu,
      identityOf({
        hardware: {
          gpu: [
            { name: "basharsx4-swiftshader-hidden", weight: 3 },
            { name: "Synthetic_GPU.v2", weight: 1 },
          ],
        },
      }).hardware?.gpu,
      identityOf({ hardware: { gpu: "x".repeat(128) } }).hardware?.gpu,
    ]).toStrictEqual([
      [{ name: "basharsx4-amd-renoir", weight: 1 }],
      [
        { name: "basharsx4-swiftshader-hidden", weight: 3 },
        { name: "Synthetic_GPU.v2", weight: 1 },
      ],
      [{ name: "x".repeat(128), weight: 1 }],
    ]);
  });

  it.each(["matched", "announce"])("takes the GPU policy %s", (gpuPolicy) => {
    expect(identityOf({ hardware: { cores: 8, gpuPolicy } }).hardware?.gpuPolicy).toBe(gpuPolicy);
    expect(identityOf({ hardware: { cores: 8 } }).hardware?.gpuPolicy).toBeUndefined();
  });

  it.each([
    { gpuPolicy: "Announce", name: "another case" },
    { gpuPolicy: "hide", name: "an unknown policy" },
    { gpuPolicy: true, name: "a boolean" },
    { gpuPolicy: null, name: "null" },
  ])("refuses a GPU policy given as $name", ({ gpuPolicy }) => {
    expect(() => resolveHostConfig({ hardware: { gpuPolicy } })).toThrow(
      expect.objectContaining(refusal('host.hardware.gpuPolicy must be "matched" or "announce".')),
    );
  });

  it.each([
    { gpu: "", name: "an empty name" },
    { gpu: "x".repeat(129), name: "a name over 128 characters" },
    { gpu: ".hidden", name: "a leading dot" },
    { gpu: "..", name: "a parent reference" },
    { gpu: "personas/basharsx4", name: "a path separator" },
    { gpu: "amd renoir", name: "a space" },
    { gpu: "rénoir", name: "a letter outside A to Z" },
    { gpu: 7, name: "a number" },
    { gpu: { name: "basharsx4-amd-renoir" }, name: "a bare row" },
    {
      gpu: [{ name: "basharsx4-amd-renoir", value: 1, weight: 1 }],
      name: "a row with another field",
    },
    { gpu: [{ name: 7, weight: 1 }], name: "a row whose name is not text" },
  ])("refuses a GL persona given as $name", ({ gpu }) => {
    expect(() => resolveHostConfig({ hardware: { gpu } })).toThrow(
      expect.objectContaining(refusal(gpuMessage)),
    );
  });
});
