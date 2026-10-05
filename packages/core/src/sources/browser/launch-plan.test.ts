import { describe, expect, it } from "vite-plus/test";

import type { HostCapabilities } from "../../humanizer/contracts.ts";
import { planIdentity } from "../../humanizer/humanizer.ts";
import type { BrowserInputs } from "../../humanizer/inputs.ts";
import { CHECKED_FONT_STACK } from "../../testing/fake-font-stack.ts";
import { fixedDevice } from "../../testing/fixed-seed.ts";
import { forkWithKnobs } from "../../testing/hardware-fork.ts";
import { noPins } from "../../testing/no-pins.ts";
import goldenPlans from "./launch-plan.golden.json" with { type: "json" };
import { parseBrowserArgs, planLaunch } from "./launch-plan.ts";
import type { LaunchPlan, LaunchRequest } from "./launch-plan.ts";

const scratchDir = "/tmp/xrio-501/bAbC123";

const GL_SWITCH = /^--(?:use-gl|use-angle|enable-unsafe-swiftshader)(?:=|$)/u;

interface IdentityChoice {
  readonly headless: boolean;
  readonly platform: NodeJS.Platform;
  readonly timezone: string;
  readonly fontStack?: HostCapabilities["fontStack"];
}

const identityFor = ({ fontStack, headless, platform, timezone }: IdentityChoice): BrowserInputs =>
  planIdentity({
    capabilities:
      fontStack === undefined
        ? { permittedCpus: 32, platform }
        : { fontStack, permittedCpus: 32, platform },
    device: fixedDevice,
    exit: { facts: { kind: "unknown" }, route: "direct" },
    hostZone: timezone,
    mode: headless ? "headless" : "headed",
    pins: noPins,
  }).inputs;

const baseline = [
  "--disable-field-trial-config",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  "--disable-edgeupdater",
  "--enable-features=CDPScreenshotNewSurface",
  "--disable-hang-monitor",
  "--disable-prompt-on-repost",
  "--disable-renderer-backgrounding",
  "--force-color-profile=srgb",
  "--no-first-run",
  "--password-store=basic",
  "--use-mock-keychain",
  "--no-service-autorun",
  "--export-tagged-pdf",
  "--disable-search-engine-choice-screen",
  "--edge-skip-compat-layer-relaunch",
  "--disable-infobars",
  "--disable-search-engine-choice-screen",
  "--disable-sync",
  "--disable-blink-features=AutomationControlled",
];

const xrioSwitches = [
  "--disable-features=AutofillServerCommunication,AimServerEligibilityEnabled,AimServerRequestOnStartupEnabled",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--accept-lang=en-US,en",
];

const tail = [`--user-data-dir=${scratchDir}/profile`, "--remote-debugging-pipe", "about:blank"];

describe(planLaunch, () => {
  it("plans the headless Linux argv", () => {
    const plan = planLaunch({
      browserArgs: [],
      browserPath: "/opt/chrome/chrome",
      display: ":99",
      headless: true,
      identity: identityFor({ headless: true, platform: "linux", timezone: "UTC" }),
      scratchDir,
      xauthority: "/tmp/xvfb-run.Xauthority",
    });

    expect(plan.args).toStrictEqual([
      ...baseline,
      "--headless",
      "--mute-audio",
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
      ...xrioSwitches,
      "--enable-unsafe-swiftshader",
      "--window-size=1680,1018",
      "--window-position=0,32",
      "--screen-info={0,0 1680x1050 colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 workAreaLeft=0 workAreaRight=0 workAreaTop=32 workAreaBottom=0}",
      "--use-fake-device-for-media-stream=device-count=0",
      `--crash-dumps-dir=${scratchDir}/crashes`,
      ...tail,
    ]);
    expect(plan.env).not.toHaveProperty("DISPLAY");
    expect(plan.env).not.toHaveProperty("XAUTHORITY");
  });

  it("plans ANGLE on Vulkan instead of SwiftShader when a render node is readable", () => {
    const { args } = planLaunch({
      browserArgs: [],
      browserPath: "/opt/chrome/chrome",
      display: ":99",
      headless: false,
      identity: planIdentity({
        capabilities: { permittedCpus: 32, platform: "linux", readableRenderNode: true },
        device: fixedDevice,
        exit: { facts: { kind: "unknown" }, route: "direct" },
        hostZone: "UTC",
        mode: "headed",
        pins: noPins,
      }).inputs,
      scratchDir,
      xauthority: undefined,
    });

    expect(args.filter((arg) => GL_SWITCH.test(arg))).toStrictEqual([
      "--use-gl=angle",
      "--use-angle=vulkan",
    ]);
  });

  it("sends a fork's hardware knobs after the GPU switches and before the window's", () => {
    const { args } = planLaunch({
      browserArgs: [],
      browserPath: "/opt/xrio-chrome/chrome",
      display: undefined,
      headless: true,
      identity: planIdentity({
        capabilities: forkWithKnobs(),
        device: fixedDevice,
        exit: { facts: { kind: "unknown" }, route: "direct" },
        hostZone: "UTC",
        mode: "headless",
        pins: noPins,
      }).inputs,
      scratchDir,
      xauthority: undefined,
    });

    expect(
      args.slice(
        args.indexOf("--enable-unsafe-swiftshader"),
        args.indexOf("--window-size=1680,1018"),
      ),
    ).toStrictEqual([
      "--enable-unsafe-swiftshader",
      "--xrio-hardware-concurrency=6",
      "--xrio-device-memory=16",
    ]);
  });

  it("places the caller's switches after Xrio's and before the profile tail", () => {
    const callerSwitches = ["--no-sandbox", "--disable-gpu-compositing"];

    const plan = planLaunch({
      browserArgs: callerSwitches,
      browserPath: "/opt/chrome/chrome",
      display: undefined,
      headless: false,
      identity: identityFor({ headless: false, platform: "darwin", timezone: "UTC" }),
      scratchDir,
      xauthority: undefined,
    });

    expect(plan.args).toStrictEqual([
      ...baseline,
      ...xrioSwitches,
      "--window-size=1600,900",
      `--crash-dumps-dir=${scratchDir}/crashes`,
      ...callerSwitches,
      ...tail,
    ]);
  });

  it("plans the headed macOS argv without headless switches or a GL override", () => {
    const plan = planLaunch({
      browserArgs: [],
      browserPath: "/Applications/Chrome.app/Contents/MacOS/Chrome",
      display: undefined,
      headless: false,
      identity: identityFor({ headless: false, platform: "darwin", timezone: "UTC" }),
      scratchDir,
      xauthority: undefined,
    });

    expect(plan.args).toStrictEqual([
      ...baseline,
      ...xrioSwitches,
      "--window-size=1600,900",
      `--crash-dumps-dir=${scratchDir}/crashes`,
      ...tail,
    ]);
  });

  it("keeps one copy of each feature switch and never weakens the sandbox or automation flags", () => {
    const { args } = planLaunch({
      browserArgs: [],
      browserPath: "chrome",
      display: ":0",
      headless: true,
      identity: identityFor({ headless: true, platform: "linux", timezone: "UTC" }),
      scratchDir,
      xauthority: undefined,
    });

    expect(args.filter((arg) => arg.startsWith("--enable-features="))).toHaveLength(1);
    expect(args.filter((arg) => arg.startsWith("--disable-features="))).toHaveLength(1);
    expect(
      args.filter((arg) =>
        ["--enable-automation", "--no-sandbox", "--hide-scrollbars"].includes(arg),
      ),
    ).toStrictEqual([]);
  });

  it("builds the child environment explicitly", () => {
    expect(
      planLaunch({
        browserArgs: [],
        browserPath: "chrome",
        display: ":7",
        headless: false,
        identity: identityFor({ headless: false, platform: "linux", timezone: "America/Chicago" }),
        scratchDir,
        xauthority: "/tmp/xvfb-run.Xauthority",
      }).env,
    ).toStrictEqual({
      DISPLAY: ":7",
      HOME: `${scratchDir}/home`,
      LANG: "C.UTF-8",
      LANGUAGE: "en_US",
      TMPDIR: `${scratchDir}/tmp`,
      TZ: "America/Chicago",
      XAUTHORITY: "/tmp/xvfb-run.Xauthority",
      XDG_CACHE_HOME: `${scratchDir}/home/.cache`,
      XDG_CONFIG_HOME: `${scratchDir}/home/.config`,
      XDG_DATA_HOME: `${scratchDir}/home/.local/share`,
    });
  });

  it("pins fontconfig to the checked stack, with the per-profile fonts.conf in the scratch", () => {
    const plan = planLaunch({
      browserArgs: [],
      browserPath: "/opt/chrome/chrome",
      display: undefined,
      headless: true,
      identity: identityFor({
        fontStack: CHECKED_FONT_STACK,
        headless: true,
        platform: "linux",
        timezone: "UTC",
      }),
      scratchDir,
      xauthority: undefined,
    });

    expect({
      file: plan.env.FONTCONFIG_FILE,
      path: plan.env.FONTCONFIG_PATH,
      variables: Object.keys(plan.env).filter((name) => name.startsWith("FONTCONFIG")),
    }).toStrictEqual({
      file: `${scratchDir}/home/identity-files/fonts.conf`,
      path: "/opt/xrio-chrome/fontstack/fonts",
      variables: ["FONTCONFIG_PATH", "FONTCONFIG_FILE"],
    });
    expect(plan.files.map(({ path: file }) => file)).toStrictEqual([
      `${scratchDir}/profile/Default/Preferences`,
      `${scratchDir}/profile/Local State`,
      `${scratchDir}/home/identity-files/fonts.conf`,
    ]);
  });

  it("sets neither fontconfig variable without a checked stack, or off Linux", () => {
    const stackless = [
      identityFor({ headless: true, platform: "linux", timezone: "UTC" }),
      identityFor({
        fontStack: {
          kind: "refused",
          reason: "fc-list printed 0 families, the manifest lists 175",
        },
        headless: true,
        platform: "linux",
        timezone: "UTC",
      }),
      identityFor({
        fontStack: CHECKED_FONT_STACK,
        headless: true,
        platform: "darwin",
        timezone: "UTC",
      }),
    ].map((identity) =>
      planLaunch({
        browserArgs: [],
        browserPath: "/opt/chrome/chrome",
        display: undefined,
        headless: true,
        identity,
        scratchDir,
        xauthority: undefined,
      }),
    );

    expect(
      stackless.map(({ env, files }) => [
        Object.keys(env).filter((name) => name.startsWith("FONTCONFIG")),
        files.length,
      ]),
    ).toStrictEqual([
      [[], 2],
      [[], 2],
      [[], 2],
    ]);
  });

  it("writes the prediction, language and DNS-over-HTTPS preferences", () => {
    const { files } = planLaunch({
      browserArgs: [],
      browserPath: "chrome",
      display: undefined,
      headless: true,
      identity: identityFor({ headless: true, platform: "linux", timezone: "UTC" }),
      scratchDir,
      xauthority: undefined,
    });

    expect(
      files.map(({ contents, path }) => {
        const parsed: unknown = JSON.parse(contents);

        return { contents: parsed, path };
      }),
    ).toStrictEqual([
      {
        contents: {
          intl: { accept_languages: "en-US,en" },
          net: { network_prediction_options: 2 },
        },
        path: `${scratchDir}/profile/Default/Preferences`,
      },
      {
        contents: { auth: { schemes: "" }, dns_over_https: { mode: "off" } },
        path: `${scratchDir}/profile/Local State`,
      },
    ]);
  });

  it("plans a pinned locale's language switch, environment and preference, and no --lang", () => {
    const { args, env, files } = planLaunch({
      browserArgs: [],
      browserPath: "chrome",
      display: undefined,
      headless: true,
      identity: planIdentity({
        capabilities: { permittedCpus: 32, platform: "linux" },
        device: fixedDevice,
        exit: { facts: { kind: "unknown" }, route: "direct" },
        hostZone: "UTC",
        mode: "headless",
        pins: { display: undefined, hardware: undefined, locale: "de-DE", timezone: undefined },
      }).inputs,
      scratchDir,
      xauthority: undefined,
    });

    expect(
      args.filter((arg) => arg.startsWith("--lang") || arg.startsWith("--accept-lang")),
    ).toStrictEqual(["--accept-lang=de-DE,de,en-US,en"]);
    expect([env.LANG, env.LANGUAGE]).toStrictEqual(["C.UTF-8", "de_DE"]);
    expect(files[0].contents).toBe(
      '{"intl":{"accept_languages":"de-DE,de,en-US,en"},"net":{"network_prediction_options":2}}',
    );
  });

  it("keeps Chrome's singleton socket path within the 108-byte limit", () => {
    const { env } = planLaunch({
      browserArgs: [],
      browserPath: "chrome",
      display: undefined,
      headless: true,
      identity: identityFor({ headless: true, platform: "linux", timezone: "UTC" }),
      scratchDir,
      xauthority: undefined,
    });

    const socket = `${env.TMPDIR}/.org.chromium.Chromium.XXXXXX/SingletonSocket`;

    expect(Buffer.byteLength(socket)).toBeLessThan(108);
  });
});

interface GoldenPlan {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly { readonly path: string; readonly contents: string }[];
}

const golden: Readonly<Record<string, GoldenPlan>> = goldenPlans;

interface GoldenCase extends IdentityChoice {
  readonly display: string | undefined;
  readonly xauthority: string | undefined;
}

const labelOf = ({ display, headless, platform, timezone, xauthority }: GoldenCase): string =>
  [
    headless ? "headless" : "headed",
    platform,
    `timezone=${timezone}`,
    `display=${display ?? "unset"}`,
    `xauthority=${xauthority ?? "unset"}`,
  ].join(" ");

const goldenCases: readonly GoldenCase[] = [true, false].flatMap((headless) =>
  (["linux", "darwin"] as const).flatMap((platform) =>
    ["UTC", "America/Chicago"].flatMap((timezone) =>
      [undefined, ":7"].flatMap((display) =>
        [undefined, "/tmp/xvfb-run.Xauthority"].map((xauthority) => ({
          display,
          headless,
          platform,
          timezone,
          xauthority,
        })),
      ),
    ),
  ),
);

const requestOf = ({
  display,
  headless,
  platform,
  timezone,
  xauthority,
}: GoldenCase): LaunchRequest => ({
  browserArgs: [],
  browserPath: "/opt/chrome/chrome",
  display,
  headless,
  identity: identityFor({ headless, platform, timezone }),
  scratchDir,
  xauthority,
});

const goldenOf = ({ args, env, files }: LaunchPlan): GoldenPlan => ({ args, env, files });

describe("the launch plan golden", () => {
  it("covers every combination of mode, platform, timezone, display and xauthority once", () => {
    expect(goldenCases.map(labelOf).toSorted()).toStrictEqual(Object.keys(golden).toSorted());
    expect(new Set(goldenCases.map(labelOf)).size).toBe(32);
  });

  it("holds no fontconfig variable in any plan made without a font stack", () => {
    expect(
      Object.values(golden).filter(({ env }) =>
        Object.keys(env).some((name) => name.startsWith("FONTCONFIG")),
      ),
    ).toStrictEqual([]);
  });

  it.each(goldenCases.map((goldenCase) => [labelOf(goldenCase), goldenCase] as const))(
    "plans %s as it always has",
    (label, goldenCase) => {
      const plan = goldenOf(planLaunch(requestOf(goldenCase)));

      expect(plan).toStrictEqual(golden[label]);
      expect(Object.keys(plan.env)).toStrictEqual(Object.keys(golden[label].env));
    },
  );
});

describe("the identity planLaunch accepts", () => {
  it("must come from mergeBrowserInputs, so a spread copy is refused", () => {
    const [goldenCase] = goldenCases;
    const request = requestOf(goldenCase);

    expect(() =>
      planLaunch({ ...request, identity: { ...request.identity, switches: ["--disable-gpu"] } }),
    ).toThrow("The launch identity must come from mergeBrowserInputs.");
  });
});

describe(parseBrowserArgs, () => {
  const emitted = goldenCases
    .flatMap((goldenCase) => planLaunch(requestOf(goldenCase)).args)
    .filter((arg) => arg.startsWith("--"));

  it("refuses every switch the launch plan itself emits, by name", () => {
    const sentOnce = new Set(baseline.filter((arg) => !arg.includes("=")));

    expect(new Set(emitted).size).toBeGreaterThan(30);

    for (const arg of new Set(emitted)) {
      if (sentOnce.has(arg)) {
        continue;
      }

      const [name] = arg.split("=", 1);

      expect(() => parseBrowserArgs([arg])).toThrow(
        `browserArgs cannot include ${name}, which Xrio manages.`,
      );
    }
  });

  it.each([
    "--use-fake-device-for-media-stream",
    "--use-fake-device-for-media-stream=device-count=0",
    "--use-fake-ui-for-media-stream",
    "--auto-accept-camera-and-microphone-capture",
    "--deny-permission-prompts",
    "--disable-audio-input",
    "--disable-audio-output",
    "--use-file-for-fake-audio-capture=/tmp/silence.wav",
    "--use-file-for-fake-video-capture=/tmp/clip.y4m",
    "--alsa-input-device=default",
    "--alsa-output-device=default",
  ])("refuses the media switch %s, which would change the devices or grant permission", (arg) => {
    const [name] = arg.split("=", 1);

    expect(() => parseBrowserArgs([arg])).toThrow(
      `browserArgs cannot include ${name}, which Xrio manages.`,
    );
  });

  it("drops a valueless baseline switch, which Chrome already gets, and refuses it with a value", () => {
    const sentOnce = baseline.filter((arg) => !arg.includes("="));

    expect(sentOnce).toContain("--disable-dev-shm-usage");

    for (const arg of sentOnce) {
      expect(parseBrowserArgs([arg, "--no-sandbox"])).toStrictEqual(["--no-sandbox"]);
      expect(() => parseBrowserArgs([`${arg}=1`])).toThrow(
        `browserArgs cannot include ${arg}, which Xrio manages.`,
      );
    }
  });

  it("accepts a switch the plan does not emit, with or without a value", () => {
    expect(
      parseBrowserArgs(["--no-sandbox", "--disable-gpu-compositing", "--x=a b=c"]),
    ).toStrictEqual(["--no-sandbox", "--disable-gpu-compositing", "--x=a b=c"]);
  });
});
