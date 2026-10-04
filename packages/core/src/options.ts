import { CacheDir, defaultCacheDir } from "./cache-dir.ts";
import { invalidOptions, redactUrl } from "./errors.ts";
import type { DeviceRecord, DisplayTables, Insets, WindowPin } from "./humanizer/contracts.ts";
import { displayMisfit } from "./humanizer/draws.ts";
import { chromeAcceptLanguages, measuredLocalesFor } from "./humanizer/owned-inputs.ts";
import { recordOverrides } from "./humanizer/surfaces.ts";
import { canonicalZone } from "./humanizer/zone-name.ts";
import { parseBrowserArgs } from "./sources/browser/launch-plan.ts";
import type {
  ClientDefaults,
  ClientOptions,
  DisplayOptions,
  ModeOptions,
  ProxyEndpoint,
  ResolvedMode,
  ScrapeOptions,
  ScrapeRequest,
  ScreenSize,
  Taskbar,
  WindowSize,
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

const DISPLAY_FIELDS = new Set(["screen", "taskbar", "window"]);

const EDGES = ["top", "right", "bottom", "left"] as const;

const TASKBAR_FIELDS = new Set<string>([...EDGES, "weight"]);

const SCREEN_FIELDS = new Set(["width", "height", "weight"]);

const WINDOW_FIELDS = new Set(["width", "height", "x", "y", "weight"]);

type DisplayEntry = DisplayOptions | ScreenSize | Taskbar | WindowSize | { maximized: true };

const isPlainObject = (value: DisplayEntry): boolean =>
  Object.getPrototypeOf(value ?? 0) === Object.prototype;

const holdsOnly = (value: DisplayEntry, fields: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => fields.has(key));

const isWhole = (value: number | undefined, min: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min;

type Weighted<Row> = Row & { weight: number };

const isTable = <Row extends object>(
  value: Row | readonly Weighted<Row>[],
): value is readonly Weighted<Row>[] => Array.isArray(value);

const tableOf = <Row extends object>(
  value: Row | readonly Weighted<Row>[],
  field: string,
): readonly Weighted<Row>[] => {
  if (!isTable(value)) {
    if (!isPlainObject(value)) {
      throw invalidOptions(`display.${field} must be a value or a non-empty weighted table.`);
    }

    return [{ ...value, weight: 1 }];
  }

  const rows = value;

  if (rows.length === 0 || !rows.every(isPlainObject)) {
    throw invalidOptions(`display.${field} must be a value or a non-empty weighted table.`);
  }

  if (!rows.every(({ weight }) => Number.isFinite(weight) && weight > 0)) {
    throw invalidOptions(`display.${field} weights must be positive numbers.`);
  }

  if (!Number.isFinite(rows.reduce((total, { weight }) => total + weight, 0))) {
    throw invalidOptions(`display.${field} weights must add up to a finite number.`);
  }

  return rows;
};

const parseScreen = (row: Weighted<ScreenSize>) => {
  const { height, weight, width } = row;

  if (!holdsOnly(row, SCREEN_FIELDS) || !isWhole(width, 1) || !isWhole(height, 1)) {
    throw invalidOptions(
      "display.screen takes a width and a height in whole pixels, such as { width: 1440, height: 900 }.",
    );
  }

  return { height, weight, width };
};

const parseTaskbar = (row: Weighted<Taskbar>): Weighted<Insets> => {
  const edges = EDGES.map((edge) => row[edge] ?? 0);

  if (!holdsOnly(row, TASKBAR_FIELDS) || !edges.every((edge) => isWhole(edge, 0))) {
    throw invalidOptions(
      "display.taskbar takes top, right, bottom and left insets in whole pixels, such as { bottom: 48 }.",
    );
  }

  const [top, right, bottom, left] = edges;

  return { bottom, left, right, top, weight: row.weight };
};

type WindowRow = WindowSize | { maximized: true } | "maximized";

const parseSize = (row: WindowSize): WindowPin => {
  const { height, width, x, y } = row;

  if (!holdsOnly(row, WINDOW_FIELDS) || !isWhole(width, 1) || !isWhole(height, 1)) {
    throw invalidOptions(
      "display.window takes a width and a height in whole pixels, with an optional x and y.",
    );
  }

  if (x === undefined && y === undefined) {
    return { height, kind: "sized", width };
  }

  if (!isWhole(x, 0) || !isWhole(y, 0)) {
    throw invalidOptions("display.window x and y must be given together, as whole pixels.");
  }

  return { height, kind: "sized", position: { x, y }, width };
};

const MAXIMIZED_FIELDS = new Set(["maximized", "weight"]);

const parseWindow = (row: WindowRow, weight: number): Weighted<WindowPin> => {
  if (row === "maximized") {
    return { kind: "maximized", weight };
  }

  if ("maximized" in row) {
    if (!Object.is(row.maximized, true) || !holdsOnly(row, MAXIMIZED_FIELDS)) {
      throw invalidOptions(
        "display.window rows that maximize take only { maximized: true, weight }, with no size.",
      );
    }

    return { kind: "maximized", weight };
  }

  if (!("width" in row)) {
    throw invalidOptions(
      'display.window must be "maximized" or a size such as { width: 1440, height: 860 }.',
    );
  }

  return { ...parseSize(row), weight };
};

const parseWindows = (window: NonNullable<DisplayOptions["window"]>) =>
  window === "maximized"
    ? [parseWindow(window, 1)]
    : tableOf<Exclude<WindowRow, "maximized">>(window, "window").map((row) =>
        parseWindow(row, row.weight),
      );

const parseDisplay = (display: DisplayOptions): DisplayTables => {
  if (!isPlainObject(display) || !holdsOnly(display, DISPLAY_FIELDS)) {
    throw invalidOptions("display takes screen, taskbar and window.");
  }

  const { screen, taskbar, window } = display;

  return {
    screens: screen === undefined ? undefined : tableOf(screen, "screen").map(parseScreen),
    taskbars: taskbar === undefined ? undefined : tableOf(taskbar, "taskbar").map(parseTaskbar),
    windows: window === undefined ? undefined : parseWindows(window),
  };
};

const fittedDisplay = (tables: DisplayTables): DisplayTables => {
  const misfit = displayMisfit(tables);

  if (misfit !== undefined) {
    throw invalidOptions(misfit);
  }

  return tables;
};

const resolveDisplay = (
  display: DisplayOptions | undefined,
  { mode }: ResolvedMode,
  defaults?: DisplayTables,
): DisplayTables | undefined => {
  if (mode === "http") {
    if (display !== undefined) {
      throw invalidOptions("display is only supported in browser modes.");
    }

    return undefined;
  }

  if (display === undefined) {
    return defaults;
  }

  const { screens, taskbars, windows } = parseDisplay(display);

  return fittedDisplay({
    screens: screens ?? defaults?.screens,
    taskbars: taskbars ?? defaults?.taskbars,
    windows: windows ?? defaults?.windows,
  });
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
  const display = resolveDisplay(options.display, mode);

  const cacheDir =
    options.cacheDir === undefined ? defaultCacheDir() : new CacheDir(options.cacheDir);

  return {
    browserArgs,
    cacheDir,
    display,
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

  const display = resolveDisplay(options.display, mode, defaults.display);

  const pins = { display, locale, timezone: mode.mode === "http" ? undefined : timezone };

  const source =
    mode.mode === "http"
      ? { ...mode, pins, proxy, url }
      : { ...mode, browserArgs: defaults.browserArgs, pins, proxy, url };

  return { format, signal, source, timeoutMs };
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
