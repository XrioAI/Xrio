import { CacheDir, defaultCacheDir } from "./cache-dir.ts";
import { invalidOptions, redactUrl } from "./errors.ts";
import type {
  DeviceRecord,
  DisplayTables,
  HardwareTables,
  Insets,
  WindowPin,
} from "./humanizer/contracts.ts";
import { displayMisfit } from "./humanizer/draws.ts";
import {
  chromeAcceptLanguages,
  FORK_MAX_CORES,
  measuredLocalesFor,
  REPORTABLE_MEMORY_GB,
} from "./humanizer/owned-inputs.ts";
import { recordOverrides } from "./humanizer/surfaces.ts";
import { canonicalZone } from "./humanizer/zone-name.ts";
import type { ClientDefaults, ScrapeIntent } from "./intent.ts";
import { parseBrowserArgs } from "./sources/browser/launch-plan.ts";
import type {
  ClientOptions,
  DisplayOptions,
  HardwareOptions,
  ModeOptions,
  ProxyEndpoint,
  ResolvedMode,
  ScrapeOptions,
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

const resolveBrowserArgs = (browserArgs: readonly string[] | undefined): readonly string[] =>
  browserArgs === undefined ? [] : parseBrowserArgs(browserArgs);

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

type OptionEntry = DisplayEntry | HardwareOptions | { value: number };

const isPlainObject = (value: OptionEntry): boolean =>
  Object.getPrototypeOf(value ?? 0) === Object.prototype;

const holdsOnly = (value: OptionEntry, fields: ReadonlySet<string>): boolean =>
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
      throw invalidOptions(`${field} must be a value or a non-empty weighted table.`);
    }

    return [{ ...value, weight: 1 }];
  }

  const rows = value;

  if (rows.length === 0 || !rows.every(isPlainObject)) {
    throw invalidOptions(`${field} must be a value or a non-empty weighted table.`);
  }

  if (!rows.every(({ weight }) => Number.isFinite(weight) && weight > 0)) {
    throw invalidOptions(`${field} weights must be positive numbers.`);
  }

  if (!Number.isFinite(rows.reduce((total, { weight }) => total + weight, 0))) {
    throw invalidOptions(`${field} weights must add up to a finite number.`);
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
    : tableOf<Exclude<WindowRow, "maximized">>(window, "display.window").map((row) =>
        parseWindow(row, row.weight),
      );

const parseDisplay = (display: DisplayOptions): DisplayTables => {
  if (!isPlainObject(display) || !holdsOnly(display, DISPLAY_FIELDS)) {
    throw invalidOptions("display takes screen, taskbar and window.");
  }

  const { screen, taskbar, window } = display;

  return {
    screens: screen === undefined ? undefined : tableOf(screen, "display.screen").map(parseScreen),
    taskbars:
      taskbar === undefined ? undefined : tableOf(taskbar, "display.taskbar").map(parseTaskbar),
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

const HARDWARE_FIELDS = new Set(["cores", "memoryGb"]);

const HARDWARE_ROW_FIELDS = new Set(["value", "weight"]);

type HardwareField = keyof HardwareOptions;

const isCoreCount = (value: number | undefined): boolean =>
  isWhole(value, 1) && value <= FORK_MAX_CORES;

const isReportableMemory = (value: number | undefined): boolean =>
  REPORTABLE_MEMORY_GB.some((memory) => memory === value);

const HARDWARE_VALUES = {
  cores: {
    isValid: isCoreCount,
    message: `hardware.cores must be a positive whole number of at most ${FORK_MAX_CORES}, or a weighted table of them.`,
  },
  memoryGb: {
    isValid: isReportableMemory,
    message: "hardware.memoryGb must be 2, 4, 8, 16 or 32 GB, or a weighted table of them.",
  },
} as const satisfies Record<
  HardwareField,
  { isValid: (value: number | undefined) => boolean; message: string }
>;

type HardwareValue = number | readonly Weighted<{ value: number }>[];

const isValueTable = (value: HardwareValue): value is readonly Weighted<{ value: number }>[] =>
  Array.isArray(value);

const parseHardwareField = (
  field: HardwareField,
  value: HardwareValue,
): NonNullable<HardwareTables[HardwareField]> => {
  const { isValid, message } = HARDWARE_VALUES[field];

  const rows = isValueTable(value)
    ? tableOf<{ value: number }>(value, `hardware.${field}`)
    : [{ value, weight: 1 }];

  if (!rows.every((row) => holdsOnly(row, HARDWARE_ROW_FIELDS))) {
    throw invalidOptions(`hardware.${field} rows take only a value and a weight.`);
  }

  if (!rows.every((row) => isValid(row.value))) {
    throw invalidOptions(message);
  }

  return rows.map(({ value: entry, weight }) => ({ value: entry, weight }));
};

const parseHardware = (hardware: HardwareOptions): HardwareTables => {
  if (!isPlainObject(hardware) || !holdsOnly(hardware, HARDWARE_FIELDS)) {
    throw invalidOptions("hardware takes cores and memoryGb.");
  }

  const { cores, memoryGb } = hardware;

  return {
    cores: cores === undefined ? undefined : parseHardwareField("cores", cores),
    memoryGb: memoryGb === undefined ? undefined : parseHardwareField("memoryGb", memoryGb),
  };
};

const resolveHardware = (
  hardware: HardwareOptions | undefined,
  { mode }: ResolvedMode,
  defaults?: HardwareTables,
): HardwareTables | undefined => {
  if (mode === "http") {
    if (hardware !== undefined) {
      throw invalidOptions("hardware is only supported in browser modes.");
    }

    return undefined;
  }

  if (hardware === undefined) {
    return defaults;
  }

  const { cores, memoryGb } = parseHardware(hardware);

  return { cores: cores ?? defaults?.cores, memoryGb: memoryGb ?? defaults?.memoryGb };
};

export const resolveClientOptions = (options?: ClientOptions): ClientDefaults => {
  if (options === undefined) {
    throw invalidOptions("browserPath is required for headed mode.");
  }

  const maxBrowsers = resolveMaxBrowsers(options.maxBrowsers);
  const mode = resolveMode(options);
  const browserArgs = resolveBrowserArgs(options.browserArgs);
  const proxy = options.proxy === undefined ? undefined : parseProxy(options.proxy);
  const locale = resolveLocale(options.locale);
  const timezone = resolveTimezone(options.timezone, mode);
  const display = resolveDisplay(options.display, mode);
  const hardware = resolveHardware(options.hardware, mode);

  const cacheDir =
    options.cacheDir === undefined ? defaultCacheDir() : new CacheDir(options.cacheDir);

  return {
    browser: { browserArgs, browserPath: options.browserPath },
    cacheDir,
    identity: { display, hardware, locale, timezone },
    maxBrowsers,
    mode: mode.mode,
    route: proxy,
    session: { kind: "anonymous" },
  };
};

export const resolveScrapeIntent = (
  options: ScrapeOptions,
  defaults: ClientDefaults,
): ScrapeIntent => {
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

  const proxy = options.proxy === undefined ? defaults.route : parseProxy(options.proxy);

  if (proxy !== undefined && mode.mode !== "http") {
    throw invalidOptions('proxy is not supported in browser modes yet; use mode: "http".');
  }

  if ("browserArgs" in options && options.browserArgs !== undefined) {
    throw invalidOptions("browserArgs is a client option.");
  }

  const locale =
    options.locale === undefined ? defaults.identity.locale : resolveLocale(options.locale);

  const timezone =
    options.timezone === undefined
      ? defaults.identity.timezone
      : resolveTimezone(options.timezone, mode);

  const display = resolveDisplay(options.display, mode, defaults.identity.display);
  const hardware = resolveHardware(options.hardware, mode, defaults.identity.hardware);

  const identity = {
    display,
    hardware,
    locale,
    timezone: mode.mode === "http" ? undefined : timezone,
  };

  const source =
    mode.mode === "http" ? mode : { ...mode, browserArgs: defaults.browser.browserArgs };

  return {
    format,
    identity,
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
