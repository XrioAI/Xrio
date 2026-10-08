import { CacheDir, defaultCacheDir } from "./cache-dir.ts";
import { invalidOptions, redactUrl } from "./errors.ts";
import { resolveHostConfig } from "./host-config.ts";
import type { HostSettings } from "./host-config.ts";
import type { DeviceRecord } from "./humanizer/contracts.ts";
import { recordOverrides } from "./humanizer/surfaces.ts";
import type { ClientDefaults, ScrapeIntent } from "./intent.ts";
import { parseSeedCookies } from "./seed-cookies.ts";
import { parseBrowserArgs } from "./sources/browser/launch-plan.ts";
import type {
  ClientOptions,
  ModeOptions,
  ProxyEndpoint,
  ResolvedMode,
  ScrapeOptions,
  WaitFor,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const MAX_TIMEOUT_MS = 2_147_483_647;

const isWaitFor = (value: unknown): value is WaitFor =>
  typeof value === "object" &&
  value !== null &&
  "selector" in value &&
  typeof value.selector === "string" &&
  value.selector.trim() !== "";

const proxyProtocols = new Map<string, ProxyEndpoint["protocol"]>([
  ["http:", "http"],
  ["https:", "https"],
  ["socks5:", "socks5"],
  ["socks5h:", "socks5"],
]);

const defaultProxyPorts = { http: 80, https: 443, socks5: 1080 } as const satisfies Record<
  ProxyEndpoint["protocol"],
  number
>;

const resolveMode = ({
  mode = "headed",
  browserPath,
}: {
  mode?: ModeOptions["mode"];
  browserPath?: string;
}): ResolvedMode => {
  switch (mode) {
    case "http": {
      return { mode };
    }

    case "headless":
    case "headed": {
      if (browserPath === undefined || browserPath.trim().length === 0) {
        throw invalidOptions(`browserPath is required for ${mode} mode.`);
      }

      return { browserPath, mode };
    }

    default: {
      throw invalidOptions("Unknown scrape mode.");
    }
  }
};

const decodeCredential = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw invalidOptions("proxy credentials contain malformed percent-encoding.", error);
  }
};

const normalizedHostname = (url: URL): string | undefined =>
  url.protocol === "http:" || url.protocol === "https:"
    ? url.hostname
    : URL.parse(`http://${url.host}`)?.hostname;

export const parseProxy = (value: string): ProxyEndpoint => {
  const url = URL.parse(value);

  if (url === null) {
    throw invalidOptions("proxy must be an absolute URL.");
  }

  const protocol = proxyProtocols.get(url.protocol);

  if (protocol === undefined) {
    throw invalidOptions("proxy must use http, https, socks5, or socks5h.");
  }

  const hostname = normalizedHostname(url);

  const hasExtraParts =
    (url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "";

  if (hostname === undefined || hasExtraParts) {
    throw invalidOptions("proxy must be scheme://[user:password@]host[:port].");
  }

  const hasCredentials = url.username !== "" || url.password !== "";

  return {
    credentials: hasCredentials
      ? { password: decodeCredential(url.password), username: decodeCredential(url.username) }
      : undefined,
    hostname,
    port: url.port === "" ? defaultProxyPorts[protocol] : Number(url.port),
    protocol,
    redactedUrl: redactUrl(url),
  };
};

const parseTargetUrl = (value: string): URL => {
  const url = URL.parse(value);

  if (url === null) {
    throw invalidOptions("url must be an absolute URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidOptions("url must use HTTP or HTTPS.");
  }

  if (url.username !== "" || url.password !== "") {
    throw invalidOptions(`url must not include credentials: ${redactUrl(url)}`);
  }

  return url;
};

const resolveMaxBrowsers = (maxBrowsers: number | undefined): number | undefined => {
  if (maxBrowsers !== undefined && (!Number.isInteger(maxBrowsers) || maxBrowsers < 1)) {
    throw invalidOptions("maxBrowsers must be a positive integer.");
  }

  return maxBrowsers;
};

const resolveBrowserArgs = (
  browserArgs: readonly string[] | undefined,
  configured: readonly string[] | undefined,
): readonly string[] =>
  browserArgs === undefined ? (configured ?? []) : parseBrowserArgs(browserArgs);

const refuseIdentityOptions = (options: ClientOptions | ScrapeOptions): void => {
  for (const field of ["locale", "timezone", "display", "hardware"]) {
    if (field in options) {
      throw invalidOptions(
        `${field} is not a client or scrape option. Set it in the host section of xrio.config.`,
      );
    }
  }
};

const explicitProxy = (value: string): ProxyEndpoint => {
  const proxy = parseProxy(value);
  const { credentials } = proxy;

  if (
    value.includes("{session}") ||
    credentials?.username.includes("{session}") === true ||
    credentials?.password.includes("{session}") === true
  ) {
    throw invalidOptions(
      "Proxy templates are only supported in xrio.config. Pass a concrete proxy URL to the client or scrape method.",
    );
  }

  return proxy;
};

export const resolveClientOptions = (
  options?: ClientOptions,
  host: HostSettings = resolveHostConfig(),
): ClientDefaults => {
  if (options === undefined) {
    throw invalidOptions("browserPath is required for headed mode.");
  }

  refuseIdentityOptions(options);

  const maxBrowsers = resolveMaxBrowsers(options.maxBrowsers);
  const mode = resolveMode(options);
  const browserArgs = resolveBrowserArgs(options.browserArgs, host.browserArgs);
  const proxy = options.proxy === undefined ? undefined : explicitProxy(options.proxy);

  const cacheDir =
    options.cacheDir === undefined ? defaultCacheDir() : new CacheDir(options.cacheDir);

  return {
    browser: { browserArgs, browserPath: options.browserPath },
    cacheDir,
    identity: host.identity,
    maxBrowsers,
    mode: mode.mode,
    route: proxy,
    session: { kind: "anonymous" },
  };
};

const sourceIntent = (
  options: ScrapeOptions,
  defaults: ClientDefaults,
  mode: ResolvedMode,
): ScrapeIntent["source"] => {
  if (mode.mode === "http") {
    if (options.waitFor !== undefined) {
      throw invalidOptions("waitFor is only supported in browser modes.");
    }

    return mode;
  }

  const source = { ...mode, browserArgs: defaults.browser.browserArgs };

  if (options.waitFor === undefined) {
    return source;
  }

  if (!isWaitFor(options.waitFor)) {
    throw invalidOptions("waitFor must contain a non-empty selector string.");
  }

  return { ...source, waitFor: options.waitFor };
};

export const resolveScrapeIntent = (
  options: ScrapeOptions,
  defaults: ClientDefaults,
): ScrapeIntent => {
  refuseIdentityOptions(options);

  const { format, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  if (format !== "html" && format !== "markdown" && format !== "json") {
    throw invalidOptions("Unknown scrape format.");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw invalidOptions(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }

  const url = parseTargetUrl(options.url);

  const mode =
    options.mode === undefined
      ? resolveMode({ browserPath: defaults.browser.browserPath, mode: defaults.mode })
      : resolveMode(options);

  const proxy = options.proxy === undefined ? defaults.route : explicitProxy(options.proxy);

  if ("browserArgs" in options && options.browserArgs !== undefined) {
    throw invalidOptions("browserArgs is a client option.");
  }

  if ("configFile" in options && options.configFile !== undefined) {
    throw invalidOptions("configFile is a client option.");
  }

  const source = sourceIntent(options, defaults, mode);
  const cookies = parseSeedCookies(options.cookies, url);

  return {
    cookies,
    format,
    identity: defaults.identity,
    route: proxy,
    session: defaults.session,
    signal,
    source,
    timeoutMs,
    url,
  };
};

export const refuseRecordOverrides = (
  record: DeviceRecord,
  scrape: Parameters<typeof recordOverrides>[1],
): void => {
  const overrides = recordOverrides(record, scrape);

  if (overrides.length > 0) {
    const fields = new Intl.ListFormat("en", { type: "conjunction" }).format(overrides);
    const pronoun = overrides.length === 1 ? "it" : "them";

    throw invalidOptions(
      `The session's device record fixes its ${fields}; a scrape in that session cannot change ${pronoun}.`,
    );
  }
};
