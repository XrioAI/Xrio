export const OWNED_SWITCHES = [
  "--lang",
  "--accept-lang",
  "--use-gl",
  "--use-angle",
  "--enable-unsafe-swiftshader",
  "--window-size",
  "--window-position",
  "--screen-info",
  "--use-fake-device-for-media-stream",
] as const;

export const OWNED_ENVIRONMENT = ["LANG", "LANGUAGE", "TZ", "FONTCONFIG_PATH"] as const;

export const OWNED_FILE_ENVIRONMENT = ["FONTCONFIG_FILE"] as const;

export const OWNED_PREFERENCES = [
  "intl.accept_languages",
  "net.network_prediction_options",
] as const;

export const OWNED_LOCAL_STATE = ["dns_over_https.mode"] as const;

export const OWNED_HEADERS = [
  "accept-language",
  "user-agent",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-arch",
  "sec-ch-ua-model",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-bitness",
  "sec-ch-ua-wow64",
  "sec-ch-ua-form-factors",
  "sec-ch-ua-full-version",
  "sec-ch-device-memory",
  "sec-ch-dpr",
  "sec-ch-viewport-width",
  "sec-ch-viewport-height",
] as const;

export const CHROME_ACCEPT_LANGUAGES = {
  "ar-SA": ["ar", "en-US", "en"],
  "bg-BG": ["bg-BG", "bg"],
  "cs-CZ": ["cs-CZ", "cs"],
  "da-DK": ["da-DK", "da", "en-US", "en"],
  "de-AT": ["de-AT", "de", "en-US", "en"],
  "de-CH": ["de-CH", "de", "en-US", "en"],
  "de-DE": ["de-DE", "de", "en-US", "en"],
  "el-GR": ["el-GR", "el"],
  "en-AU": ["en-AU", "en-US", "en"],
  "en-CA": ["en-CA", "en-US", "en"],
  "en-GB": ["en-GB", "en-US", "en"],
  "en-IE": ["en-IE", "en-US", "en"],
  "en-IN": ["en-IN", "en-US", "en"],
  "en-NZ": ["en-NZ", "en-US", "en"],
  "en-US": ["en-US", "en"],
  "en-ZA": ["en-ZA", "en-US", "en"],
  "es-AR": ["es-AR", "es"],
  "es-CO": ["es-CO", "es"],
  "es-ES": ["es-ES", "es"],
  "es-MX": ["es-MX", "es"],
  "fi-FI": ["fi-FI", "fi", "en-US", "en"],
  "fr-BE": ["fr-BE", "fr", "en-US", "en"],
  "fr-CA": ["fr-CA", "fr", "en-US", "en"],
  "fr-CH": ["fr-CH", "fr", "en-US", "en"],
  "fr-FR": ["fr-FR", "fr", "en-US", "en"],
  "he-IL": ["he-IL", "he", "en-US", "en"],
  "hi-IN": ["hi-IN", "hi", "en-US", "en"],
  "hu-HU": ["hu-HU", "hu", "en-US", "en"],
  "id-ID": ["id-ID", "id", "en-US", "en"],
  "it-IT": ["it-IT", "it", "en-US", "en"],
  "ja-JP": ["ja", "en-US", "en"],
  "ko-KR": ["ko-KR", "ko", "en-US", "en"],
  "nb-NO": ["nb-NO", "nb", "no", "nn", "en-US", "en"],
  "nl-BE": ["nl-BE", "nl", "en-US", "en"],
  "nl-NL": ["nl-NL", "nl", "en-US", "en"],
  "pl-PL": ["pl-PL", "pl", "en-US", "en"],
  "pt-BR": ["pt-BR", "pt", "en-US", "en"],
  "pt-PT": ["pt-PT", "pt", "en-US", "en"],
  "ro-RO": ["ro-RO", "ro", "en-US", "en"],
  "ru-RU": ["ru-RU", "ru", "en-US", "en"],
  "sk-SK": ["sk-SK", "sk", "cs", "en-US", "en"],
  "sv-SE": ["sv-SE", "sv", "en-US", "en"],
  "th-TH": ["th-TH", "th"],
  "tr-TR": ["tr-TR", "tr", "en-US", "en"],
  "uk-UA": ["uk-UA", "uk", "en-US", "en"],
  "vi-VN": ["vi-VN", "vi", "fr-FR", "fr", "en-US", "en"],
  "zh-CN": ["zh-CN", "zh"],
  "zh-HK": ["zh-HK", "zh", "en-US", "en"],
  "zh-TW": ["zh-TW", "zh", "en-US", "en"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const isShippedLocale = (tag: string): tag is keyof typeof CHROME_ACCEPT_LANGUAGES =>
  Object.hasOwn(CHROME_ACCEPT_LANGUAGES, tag);

export const measuredLocalesFor = (tag: string): readonly string[] => {
  const [language] = tag.split("-");

  return Object.keys(CHROME_ACCEPT_LANGUAGES).filter(
    (measured) => measured.split("-")[0] === language,
  );
};

export const chromeAcceptLanguages = (tag: string): readonly string[] | undefined =>
  isShippedLocale(tag) ? CHROME_ACCEPT_LANGUAGES[tag] : undefined;

const PXRENDER_SCREENS =
  "pxrender src/pxrender/browser/display.py DESKTOP_SCREENS: native DPR-1 panel sizes with approximate desktop population weights";

export const DESKTOP_SCREENS = [
  { height: 1080, source: PXRENDER_SCREENS, weight: 40, width: 1920 },
  { height: 768, source: PXRENDER_SCREENS, weight: 14, width: 1366 },
  { height: 1024, source: PXRENDER_SCREENS, weight: 11, width: 1280 },
  { height: 900, source: PXRENDER_SCREENS, weight: 8, width: 1440 },
  { height: 900, source: PXRENDER_SCREENS, weight: 7, width: 1600 },
  { height: 1440, source: PXRENDER_SCREENS, weight: 7, width: 2560 },
  { height: 1050, source: PXRENDER_SCREENS, weight: 5, width: 1680 },
  { height: 1200, source: PXRENDER_SCREENS, weight: 4, width: 1920 },
  { height: 800, source: PXRENDER_SCREENS, weight: 4, width: 1280 },
] as const;

const LAYOUT_WEIGHT_SOURCE = "guess: no population data on Linux desktop environments";

export const DESKTOP_LAYOUTS = [
  {
    insets: { bottom: 0, left: 0, right: 0, top: 32 },
    name: "gnome",
    source:
      "measured 2026-10-04: _NET_WORKAREA of Fedora 42 gnome-shell 48.8 --x11 --mode=user, and of Ubuntu 24.04 gnome-shell 46.0 --mode=user, under Xvfb at 96 dpi, 1920x1080 and 1366x768",
    weight: 25,
    weightSource: LAYOUT_WEIGHT_SOURCE,
  },
  {
    insets: { bottom: 0, left: 66, right: 0, top: 32 },
    name: "ubuntu",
    source:
      "measured 2026-10-04: _NET_WORKAREA of Ubuntu 24.04.5 ubuntu-desktop-minimal, gnome-shell 46.0 --x11 --mode=ubuntu with ubuntu-dock 90ubuntu3, under Xvfb at 96 dpi, 1920x1080 and 1366x768",
    weight: 35,
    weightSource: LAYOUT_WEIGHT_SOURCE,
  },
  {
    insets: { bottom: 44, left: 0, right: 0, top: 0 },
    name: "kde",
    source:
      "measured 2026-10-04: _NET_WORKAREA and panel strut of Kubuntu 24.04.5, Plasma 5.27.12 on kwin_x11, under Xvfb at 96 dpi, 1920x1080 and 1366x768; Fedora 42 Plasma 6.6.4 floats its panel with a 46 px strut",
    weight: 20,
    weightSource: LAYOUT_WEIGHT_SOURCE,
  },
  {
    insets: { bottom: 40, left: 0, right: 0, top: 0 },
    name: "cinnamon",
    source:
      "measured 2026-10-04: _NET_WORKAREA of Linux Mint 22 Cinnamon 6.2.10 on muffin, under Xvfb at 96 dpi, 1920x1080 and 1366x768",
    weight: 20,
    weightSource: LAYOUT_WEIGHT_SOURCE,
  },
] as const;

const WINDOW_WEIGHT_SOURCE =
  "guess: most desktop browser windows are maximized; no population data on floating sizes";

export const WINDOW_STATES = [
  { kind: "maximized", source: WINDOW_WEIGHT_SOURCE, weight: 80 },
  { kind: "floating", source: WINDOW_WEIGHT_SOURCE, weight: 20 },
] as const;

const CHROME_BAD_FLAGS = {
  chromium: "154.0.8037.57",
  linuxSwitches: ["--enable-speech-dispatcher"],
  switches: [
    "--host-resolver-rules",
    "--host-rules",
    "--log-net-log",
    "--net-log-capture-mode",
    "--disable-gpu-sandbox",
    "--disable-landlock-sandbox",
    "--disable-seccomp-filter-sandbox",
    "--disable-setuid-sandbox",
    "--disable-webnn-compiler-sandbox",
    "--no-sandbox",
    "--disable-web-security",
    "--single-process",
    "--translate-security-origin",
    "--disable-webrtc-encryption",
    "--ignore-certificate-errors",
    "--ignore-certificate-errors-spki-list",
    "--gaia-url",
    "--translate-script-url",
    "--extensions-on-chrome-urls",
    "--extensions-on-extension-urls",
    "--allowlisted-extension-id",
    "--disable-blink-features",
    "--unsafely-treat-insecure-origin-as-secure",
    "--unsafely-allow-protected-media-identifier-for-domain",
    "--disable-best-effort-tasks",
    "--disable-hid-blocklist",
    "--install-isolated-web-app-from-file",
    "--install-isolated-web-app-from-url",
    "--webauthn-remote-proxied-requests-allowed-additional-origin",
    "--history-clusters-cluster-override-file",
    "--disable-input-event-activation-protection",
    "--enable-gpu-benchmarking",
    "--cast-developer-certificate-path",
    "--ignore-bad-message-for-testing",
    "--disable-actor-safety-checks",
    "--disable-site-isolation-trials",
  ],
} as const;

export const XRIO_SENT_BAD_FLAG_SWITCHES = ["--disable-blink-features"] as const;

export const isChromeBadFlag = (name: string, platform: NodeJS.Platform): boolean =>
  CHROME_BAD_FLAGS.switches.some((bad) => bad === name) ||
  (platform === "linux" && CHROME_BAD_FLAGS.linuxSwitches.some((bad) => bad === name));

export const FORK_SWITCH_PREFIXES = ["--pxr-", "--xrio-"] as const;

export const FORK_DUMP_SWITCH = "--xrio-dump-config";

const RESERVED_IDENTITY_SWITCHES = [
  "--force-device-scale-factor",
  "--device-scale-factor",
  "--high-dpi-support",
  "--start-maximized",
  "--start-fullscreen",
  "--user-agent",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-webgl",
  "--disable-3d-apis",
  "--hide-scrollbars",
  "--enable-automation",
  "--enable-blink-features",
  "--force-dark-mode",
  "--force-prefers-reduced-motion",
  "--touch-events",
  "--force-webrtc-ip-handling-policy",
  "--webrtc-ip-handling-policy",
  "--enforce-webrtc-ip-permission-check",
  "--kiosk",
  "--app",
  "--ozone-override-screen-size",
  "--force-prefers-no-reduced-motion",
  "--force-high-contrast",
  "--disable-webgl2",
  "--disable-reading-from-canvas",
  "--use-webgpu-adapter",
  "--enable-unsafe-webgpu",
  "--disable-webgpu",
  "--js-flags",
  "--use-fake-ui-for-media-stream",
  "--use-file-for-fake-audio-capture",
  "--use-file-for-fake-video-capture",
  "--alsa-input-device",
  "--alsa-output-device",
  "--auto-accept-camera-and-microphone-capture",
  "--deny-permission-prompts",
  "--disable-audio-input",
  "--disable-audio-output",
] as const;

export const isOwnedSwitch = (name: string): boolean =>
  OWNED_SWITCHES.some((owned) => owned === name) ||
  RESERVED_IDENTITY_SWITCHES.some((reserved) => reserved === name) ||
  FORK_SWITCH_PREFIXES.some((prefix) => name.startsWith(prefix));

export type LaunchInput =
  | {
      readonly sink: "switch";
      readonly name: (typeof OWNED_SWITCHES)[number];
      readonly value?: string;
    }
  | {
      readonly sink: "environment";
      readonly name: (typeof OWNED_ENVIRONMENT)[number];
      readonly value: string;
    }
  | {
      readonly sink: "file-environment";
      readonly name: (typeof OWNED_FILE_ENVIRONMENT)[number];
      readonly file: string;
      readonly contents: string;
    }
  | {
      readonly sink: "preference";
      readonly name: (typeof OWNED_PREFERENCES)[number];
      readonly value: string | number;
    }
  | {
      readonly sink: "local-state";
      readonly name: (typeof OWNED_LOCAL_STATE)[number];
      readonly value: string;
    };
