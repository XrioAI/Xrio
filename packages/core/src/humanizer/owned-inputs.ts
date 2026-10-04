export const OWNED_SWITCHES = [
  "--lang",
  "--accept-lang",
  "--use-gl",
  "--use-angle",
  "--window-size",
  "--screen-info",
  "--use-fake-device-for-media-stream",
] as const;

export const OWNED_ENVIRONMENT = ["LANG", "LANGUAGE"] as const;

export const FORWARDED_ENVIRONMENT = ["TZ"] as const;

export const OWNED_PREFERENCES = [
  "intl.accept_languages",
  "net.network_prediction_options",
] as const;

export const OWNED_LOCAL_STATE = ["dns_over_https.mode"] as const;

export const OWNED_HEADERS = ["accept-language"] as const;

export const FORK_SWITCH_PREFIXES = ["--pxr-", "--xrio-"] as const;

const RESERVED_IDENTITY_SWITCHES = [
  "--force-device-scale-factor",
  "--device-scale-factor",
  "--high-dpi-support",
  "--window-position",
  "--start-maximized",
  "--start-fullscreen",
  "--user-agent",
  "--disable-gpu",
  "--enable-unsafe-swiftshader",
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
      readonly value: string;
    }
  | {
      readonly sink: "environment";
      readonly name: (typeof OWNED_ENVIRONMENT)[number];
      readonly value: string;
    }
  | {
      readonly sink: "forwarded-environment";
      readonly name: (typeof FORWARDED_ENVIRONMENT)[number];
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
