import { CacheDir, defaultCacheDir } from "./cache-dir.ts";
import { invalidOptions, redactUrl } from "./errors.ts";
import { chromeAcceptLanguages, measuredLocalesFor } from "./humanizer/owned-inputs.ts";
import { canonicalZone } from "./humanizer/zone-name.ts";
import { parseBrowserArgs } from "./sources/browser/launch-plan.ts";
import type {
  ClientDefaults,
  ClientOptions,
  ModeOptions,
  ProxyEndpoint,
  ResolvedMode,
  ScrapeOptions,
  ScrapeRequest,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

const MAX_TIMEOUT_MS = 2_147_483_647;

const POSIX_LOCALE_MARKS = /[_.@]/u;

const POSIX_LOCALE_MESSAGE =
  "locale must be a BCP 47 language tag such as de-DE, not a POSIX locale such as en_US.UTF-8.";

const BCP47_LOCALE_MESSAGE = "locale must be one BCP 47 language tag such as de-DE.";

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

const resolveMode = ({ mode = "headed", browserPath }: ModeOptions): ResolvedMode => {
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

const parseProxy = (value: string): ProxyEndpoint => {
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

const malformedLocale = (locale: string, cause?: unknown) =>
  invalidOptions(
    POSIX_LOCALE_MARKS.test(locale) ? POSIX_LOCALE_MESSAGE : BCP47_LOCALE_MESSAGE,
    cause,
  );

const canonicalLocales = (locale: string): readonly string[] => {
  try {
    return Intl.getCanonicalLocales(locale);
  } catch (error) {
    throw malformedLocale(locale, error);
  }
};

const unmeasuredLocale = (tag: string) => {
  const measured = measuredLocalesFor(tag);

  const suggestion =
    measured.length === 0
      ? ""
      : ` Try ${new Intl.ListFormat("en", { type: "disjunction" }).format(measured)}.`;

  return invalidOptions(
    `locale ${tag} is not one Xrio has measured Chrome's language list for.${suggestion}`,
  );
};

const resolveLocale = (locale: string | undefined): string | undefined => {
  if (locale === undefined) {
    return undefined;
  }

  const [tag, ...extra] = canonicalLocales(locale);

  if (tag === undefined || extra.length > 0) {
    throw malformedLocale(locale);
  }

  if (chromeAcceptLanguages(tag) === undefined) {
    throw unmeasuredLocale(tag);
  }

  return tag;
};

const resolveMaxBrowsers = (maxBrowsers: number | undefined): number | undefined => {
  if (maxBrowsers !== undefined && (!Number.isInteger(maxBrowsers) || maxBrowsers < 1)) {
    throw invalidOptions("maxBrowsers must be a positive integer.");
  }

  return maxBrowsers;
};

const resolveBrowserArgs = (
  browserArgs: readonly string[] | undefined,
  { mode }: ResolvedMode,
): readonly string[] => {
  if (browserArgs === undefined) {
    return [];
  }

  if (mode === "http") {
    throw invalidOptions("browserArgs is only supported in browser modes.");
  }

  return parseBrowserArgs(browserArgs);
};

const resolveTimezone = (
  timezone: string | undefined,
  { mode }: ResolvedMode,
): string | undefined => {
  if (timezone === undefined) {
    return undefined;
  }

  if (mode === "http") {
    throw invalidOptions("timezone is only supported in browser modes.");
  }

  const zone = canonicalZone(timezone);

  if (zone === undefined) {
    throw invalidOptions("timezone must be an IANA zone name such as America/New_York.");
  }

  return zone;
};

export const resolveClientOptions = (options?: ClientOptions): ClientDefaults => {
  if (options === undefined) {
    throw invalidOptions("browserPath is required for headed mode.");
  }

  const maxBrowsers = resolveMaxBrowsers(options.maxBrowsers);
  const mode = resolveMode(options);
  const browserArgs = resolveBrowserArgs(options.browserArgs, mode);
  const proxy = options.proxy === undefined ? undefined : parseProxy(options.proxy);
  const locale = resolveLocale(options.locale);
  const timezone = resolveTimezone(options.timezone, mode);

  const cacheDir =
    options.cacheDir === undefined ? defaultCacheDir() : new CacheDir(options.cacheDir);

  return {
    browserArgs,
    cacheDir,
    locale,
    maxBrowsers,
    mode,
    proxy,
    timezone,
  };
};

export const resolveScrapeOptions = (
  options: ScrapeOptions,
  defaults: ClientDefaults,
): ScrapeRequest => {
  const { format, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options;

  if (format !== "html" && format !== "markdown" && format !== "json") {
    throw invalidOptions("Unknown scrape format.");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw invalidOptions(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }

  const url = parseTargetUrl(options.url);
  const mode = options.mode === undefined ? defaults.mode : resolveMode(options);
  const proxy = options.proxy === undefined ? defaults.proxy : parseProxy(options.proxy);

  if (proxy !== undefined && mode.mode !== "http") {
    throw invalidOptions('proxy is not supported in browser modes yet; use mode: "http".');
  }

  if ("browserArgs" in options && options.browserArgs !== undefined) {
    throw invalidOptions("browserArgs is a client option.");
  }

  const locale = options.locale === undefined ? defaults.locale : resolveLocale(options.locale);

  const timezone =
    options.timezone === undefined ? defaults.timezone : resolveTimezone(options.timezone, mode);

  const pins = { locale, timezone: mode.mode === "http" ? undefined : timezone };

  const source =
    mode.mode === "http"
      ? { ...mode, pins, proxy, url }
      : { ...mode, browserArgs: defaults.browserArgs, pins, proxy, url };

  return { format, signal, source, timeoutMs };
};
