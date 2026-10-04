import path from "node:path";

import { invalidOptions } from "../../errors.ts";
import { isMinted } from "../../humanizer/inputs.ts";
import type { BrowserInputs } from "../../humanizer/inputs.ts";
import { isOwnedSwitch } from "../../humanizer/owned-inputs.ts";

export interface LaunchRequest {
  browserPath: string;
  browserArgs: readonly string[];
  headless: boolean;
  scratchDir: string;
  display: string | undefined;
  xauthority: string | undefined;
  identity: BrowserInputs;
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
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  directories: LaunchDirectories;
  files: readonly ProfileFile[];
}

const SWITCH = /^--[^\s=-][^\s=]*(?:=.*)?$/su;

const HEADLESS_POINTER_SETTINGS =
  "primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4";

const DISABLED_FEATURES = [
  "AutofillServerCommunication",
  "AimServerEligibilityEnabled",
  "AimServerRequestOnStartupEnabled",
] as const;

const chromeBaselineSwitches = [
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

const chromeHeadlessSwitches = [
  "--headless",
  "--mute-audio",
  `--blink-settings=${HEADLESS_POINTER_SETTINGS}`,
] as const;

const switchNameOf = (entry: string): string => entry.split("=", 1)[0];

const SET_BY_BASELINE: ReadonlySet<string> = new Set(
  chromeBaselineSwitches.filter((entry) => !entry.includes("=")),
);

const MANAGED_SWITCHES: ReadonlySet<string> = new Set([
  ...[...chromeBaselineSwitches, ...chromeHeadlessSwitches].map(switchNameOf),
  "--disable-features",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--crash-dumps-dir",
  "--user-data-dir",
  "--profile-directory",
  "--guest",
  "--incognito",
  "--load-extension",
  "--disable-extensions-except",
  "--remote-allow-origins",
  "--proxy-server",
  "--proxy-pac-url",
  "--proxy-auto-detect",
  "--proxy-bypass-list",
  "--no-proxy-server",
]);

const MANAGED_SWITCH_PREFIXES = ["--remote-debugging-"] as const;

const isManagedSwitch = (name: string): boolean =>
  MANAGED_SWITCHES.has(name) || MANAGED_SWITCH_PREFIXES.some((prefix) => name.startsWith(prefix));

export const directoriesIn = (scratchDir: string): LaunchDirectories => ({
  crashes: path.join(scratchDir, "crashes"),
  downloads: path.join(scratchDir, "downloads"),
  home: path.join(scratchDir, "home"),
  profile: path.join(scratchDir, "profile"),
  tmp: path.join(scratchDir, "tmp"),
});

const isSwitch = (entry: unknown): entry is string =>
  typeof entry === "string" && !entry.includes("\0") && SWITCH.test(entry);

export const parseBrowserArgs = (browserArgs: readonly string[]): readonly string[] => {
  if (!Array.isArray(browserArgs)) {
    throw invalidOptions("browserArgs must be an array of strings.");
  }

  const args: string[] = [];

  for (const [index, entry] of browserArgs.entries()) {
    if (!isSwitch(entry)) {
      throw invalidOptions(
        `browserArgs entry ${index} must be a switch such as --name or --name=value.`,
      );
    }

    if (SET_BY_BASELINE.has(entry)) {
      continue;
    }

    const name = switchNameOf(entry);

    if (isOwnedSwitch(name) || isManagedSwitch(name)) {
      throw invalidOptions(`browserArgs cannot include ${name}, which Xrio manages.`);
    }

    args.push(entry);
  }

  return Object.freeze(args);
};

const xrioSwitches = ({ identity }: LaunchRequest, directories: LaunchDirectories): string[] => [
  `--disable-features=${DISABLED_FEATURES.join(",")}`,
  "--disable-component-update",
  "--disable-domain-reliability",
  ...identity.switches,
  `--crash-dumps-dir=${directories.crashes}`,
];

const displayEnvironment = ({ display, headless, xauthority }: LaunchRequest) => {
  const variables = new Map<string, string>();

  if (!headless && display !== undefined) {
    variables.set("DISPLAY", display);
  }

  if (!headless && xauthority !== undefined) {
    variables.set("XAUTHORITY", xauthority);
  }

  return Object.fromEntries(variables);
};

const childEnvironment = (request: LaunchRequest, directories: LaunchDirectories) => ({
  HOME: directories.home,
  ...request.identity.environment,
  TMPDIR: directories.tmp,
  XDG_CACHE_HOME: path.join(directories.home, ".cache"),
  XDG_CONFIG_HOME: path.join(directories.home, ".config"),
  XDG_DATA_HOME: path.join(directories.home, ".local", "share"),
  ...displayEnvironment(request),
});

const profileFiles = (
  { identity }: LaunchRequest,
  directories: LaunchDirectories,
): ProfileFile[] => [
  {
    contents: JSON.stringify(identity.preferences),
    path: path.join(directories.profile, "Default", "Preferences"),
  },
  {
    contents: JSON.stringify({ auth: { schemes: "" }, ...identity.localState }),
    path: path.join(directories.profile, "Local State"),
  },
];

export const planLaunch = (request: LaunchRequest): LaunchPlan => {
  if (!isMinted(request.identity)) {
    throw new Error("The launch identity must come from mergeBrowserInputs.");
  }

  const directories = directoriesIn(request.scratchDir);

  return {
    args: [
      ...chromeBaselineSwitches,
      ...(request.headless ? chromeHeadlessSwitches : []),
      ...xrioSwitches(request, directories),
      ...request.browserArgs,
      `--user-data-dir=${directories.profile}`,
      "--remote-debugging-pipe",
      "about:blank",
    ],
    directories,
    env: childEnvironment(request, directories),
    executable: request.browserPath,
    files: profileFiles(request, directories),
  };
};
