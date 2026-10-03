import { describe, expect, it } from "vite-plus/test";

import { planIdentity } from "../../humanizer/humanizer.ts";
import type { BrowserInputs } from "../../humanizer/inputs.ts";
import goldenPlans from "./launch-plan.golden.json" with { type: "json" };
import { planLaunch } from "./launch-plan.ts";
import type { LaunchPlan, LaunchRequest } from "./launch-plan.ts";

const scratchDir = "/tmp/xrio-501/bAbC123";

interface IdentityChoice {
  readonly headless: boolean;
  readonly platform: NodeJS.Platform;
  readonly timezone: string | undefined;
}

const identityFor = ({ headless, platform, timezone }: IdentityChoice): BrowserInputs =>
  planIdentity({
    capabilities: { platform },
    hostZone: timezone,
    mode: headless ? "headless" : "headed",
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
  "--lang=en-US",
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
      identity: identityFor({ headless: true, platform: "linux", timezone: undefined }),
      scratchDir,
      xauthority: "/tmp/xvfb-run.Xauthority",
    });

    expect(plan.args).toStrictEqual([
      ...baseline,
      "--headless",
      "--mute-audio",
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
      ...xrioSwitches,
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--window-size=1600,900",
      "--screen-info={0,0 1920x1080 colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 workAreaLeft=0 workAreaRight=0 workAreaTop=0 workAreaBottom=40}",
      `--crash-dumps-dir=${scratchDir}/crashes`,
      ...tail,
    ]);
    expect(plan.env).not.toHaveProperty("DISPLAY");
    expect(plan.env).not.toHaveProperty("XAUTHORITY");
  });

  it("places the caller's switches after Xrio's and before the profile tail", () => {
    const callerSwitches = ["--no-sandbox", "--disable-gpu-compositing"];

    const plan = planLaunch({
      browserArgs: callerSwitches,
      browserPath: "/opt/chrome/chrome",
      display: undefined,
      headless: false,
      identity: identityFor({ headless: false, platform: "darwin", timezone: undefined }),
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
      identity: identityFor({ headless: false, platform: "darwin", timezone: undefined }),
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
      identity: identityFor({ headless: true, platform: "linux", timezone: undefined }),
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

  it("writes the prediction, language and DNS-over-HTTPS preferences", () => {
    const { files } = planLaunch({
      browserArgs: [],
      browserPath: "chrome",
      display: undefined,
      headless: true,
      identity: identityFor({ headless: true, platform: "linux", timezone: undefined }),
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

  it("keeps Chrome's singleton socket path within the 108-byte limit", () => {
    const { env } = planLaunch({
      browserArgs: [],
      browserPath: "chrome",
      display: undefined,
      headless: true,
      identity: identityFor({ headless: true, platform: "linux", timezone: undefined }),
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
    `timezone=${timezone ?? "unset"}`,
    `display=${display ?? "unset"}`,
    `xauthority=${xauthority ?? "unset"}`,
  ].join(" ");

const goldenCases: readonly GoldenCase[] = [true, false].flatMap((headless) =>
  (["linux", "darwin"] as const).flatMap((platform) =>
    [undefined, "America/Chicago"].flatMap((timezone) =>
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
