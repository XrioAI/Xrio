export const OWNED_SWITCHES = [
  "--lang",
  "--accept-lang",
  "--use-gl",
  "--use-angle",
  "--enable-unsafe-swiftshader",
  "--window-size",
  "--screen-info",
  "--use-fake-device-for-media-stream",
] as const;

export const OWNED_ENVIRONMENT = ["LANG", "LANGUAGE", "TZ"] as const;

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

export const FORK_SWITCH_PREFIXES = ["--pxr-", "--xrio-"] as const;

export const FORK_DUMP_SWITCH = "--xrio-dump-config";

const RESERVED_IDENTITY_SWITCHES = [
  "--force-device-scale-factor",
  "--device-scale-factor",
  "--high-dpi-support",
  "--window-position",
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
      readonly sink: "preference";
      readonly name: (typeof OWNED_PREFERENCES)[number];
      readonly value: string | number;
    }
  | {
      readonly sink: "local-state";
      readonly name: (typeof OWNED_LOCAL_STATE)[number];
      readonly value: string;
    };
