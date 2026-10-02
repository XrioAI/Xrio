import path from "node:path";

export interface LaunchRequest {
  browserPath: string;
  headless: boolean;
  scratchDir: string;
  platform: NodeJS.Platform;
  display: string | undefined;
  xauthority: string | undefined;
  timezone: string | undefined;
}

interface ProfileFile {
  path: string;
  contents: string;
}

export interface LaunchDirectories {
  profile: string;
  home: string;
  tmp: string;
  crashes: string;
  downloads: string;
}

export interface LaunchPlan {
  executable: string;
  headless: boolean;
  switches: readonly string[];
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  directories: LaunchDirectories;
  files: readonly ProfileFile[];
}

const LOCALE = "en-US";

const ACCEPT_LANGUAGES = "en-US,en";

const SCREEN = { height: 1080, width: 1920, workAreaInset: 40 } as const;

const WINDOW = { height: 900, width: 1600 } as const;

const NETWORK_PREDICTION_NEVER = 2;

const HEADLESS_POINTER_SETTINGS =
  "primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";

const DISABLED_FEATURES = [
  "AutofillServerCommunication",
  "AimServerEligibilityEnabled",
  "AimServerRequestOnStartupEnabled",
] as const;

const patchrightBaselineSwitches = [
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
] as const;

const patchrightHeadlessSwitches = [
  "--headless",
  "--mute-audio",
  `--blink-settings=${HEADLESS_POINTER_SETTINGS}`,
] as const;

export const directoriesIn = (scratchDir: string): LaunchDirectories => ({
  crashes: path.join(scratchDir, "crashes"),
  downloads: path.join(scratchDir, "downloads"),
  home: path.join(scratchDir, "home"),
  profile: path.join(scratchDir, "profile"),
  tmp: path.join(scratchDir, "tmp"),
});

const screenInfo = () =>
  `{0,0 ${SCREEN.width}x${SCREEN.height} colorDepth=24 devicePixelRatio=1 isInternal=0 rotation=0 ` +
  `workAreaLeft=0 workAreaRight=0 workAreaTop=0 workAreaBottom=${SCREEN.workAreaInset}}`;

const xrioSwitches = (
  { headless, platform }: LaunchRequest,
  directories: LaunchDirectories,
): string[] => [
  `--disable-features=${DISABLED_FEATURES.join(",")}`,
  "--disable-component-update",
  "--disable-domain-reliability",
  `--lang=${LOCALE}`,
  `--accept-lang=${ACCEPT_LANGUAGES}`,
  ...(platform === "linux" ? ["--use-gl=angle", "--use-angle=swiftshader"] : []),
  `--window-size=${WINDOW.width},${WINDOW.height}`,
  ...(headless ? [`--screen-info=${screenInfo()}`] : []),
  `--crash-dumps-dir=${directories.crashes}`,
];

const forwardedEnvironment = ({ display, headless, timezone, xauthority }: LaunchRequest) => {
  const variables = new Map<string, string>();

  if (timezone !== undefined) {
    variables.set("TZ", timezone);
  }

  if (!headless && display !== undefined) {
    variables.set("DISPLAY", display);
  }

  if (!headless && xauthority !== undefined) {
    variables.set("XAUTHORITY", xauthority);
  }

  return Object.fromEntries(variables);
};

const childEnvironment = (request: LaunchRequest, directories: LaunchDirectories) => {
  const env = {
    HOME: directories.home,
    LANG: "C.UTF-8",
    LANGUAGE: LOCALE.replace("-", "_"),
    TMPDIR: directories.tmp,
    XDG_CACHE_HOME: path.join(directories.home, ".cache"),
    XDG_CONFIG_HOME: path.join(directories.home, ".config"),
    XDG_DATA_HOME: path.join(directories.home, ".local", "share"),
  };

  return { ...env, ...forwardedEnvironment(request) };
};

const profileFiles = (directories: LaunchDirectories): ProfileFile[] => [
  {
    contents: JSON.stringify({
      intl: { accept_languages: ACCEPT_LANGUAGES },
      net: { network_prediction_options: NETWORK_PREDICTION_NEVER },
    }),
    path: path.join(directories.profile, "Default", "Preferences"),
  },
  {
    contents: JSON.stringify({ dns_over_https: { mode: "off" } }),
    path: path.join(directories.profile, "Local State"),
  },
];

export const planLaunch = (request: LaunchRequest): LaunchPlan => {
  const directories = directoriesIn(request.scratchDir);

  const baselineSwitches = [
    ...patchrightBaselineSwitches,
    ...(request.headless ? patchrightHeadlessSwitches : []),
  ];

  const switches = xrioSwitches(request, directories);

  return {
    args: [
      ...baselineSwitches,
      ...switches,
      `--user-data-dir=${directories.profile}`,
      "--remote-debugging-pipe",
      "about:blank",
    ],
    directories,
    env: childEnvironment(request, directories),
    executable: request.browserPath,
    files: profileFiles(directories),
    headless: request.headless,
    switches,
  };
};
