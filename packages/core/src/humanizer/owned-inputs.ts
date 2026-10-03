export const OWNED_SWITCHES = [
  "--lang",
  "--accept-lang",
  "--use-gl",
  "--use-angle",
  "--window-size",
  "--screen-info",
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
