import { getPublicSuffix } from "tldts";

import { publishInternalEvent } from "./diagnostics.ts";
import { invalidOptions } from "./errors.ts";
import type { ScrapeOptions } from "./types.ts";

export interface SeedCookie {
  readonly setCookieHeader: string;
  readonly name: string;
  readonly value: string;
  readonly url: string;
  readonly domain?: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
  readonly expires?: number;
  readonly maxAge?: number;
}

type SkipReason =
  | "domain-mismatch"
  | "public-suffix-domain"
  | "prefix-rules"
  | "too-large"
  | "path-too-long"
  | "same-site-none-insecure"
  | "refused-by-chrome";

export interface SkippedCookie {
  readonly name: string;
  readonly reason: SkipReason;
}

export interface CookieSeeds {
  readonly seeds: readonly SeedCookie[];
  readonly skipped: readonly SkippedCookie[];
}

const MAX_NAME_VALUE_LENGTH = 4096;

const MAX_PATH_LENGTH = 1024;

const COOKIE_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u;

const COOKIE_VALUE = /^[\u0020-\u003A\u003C-\u007E]*$/u;

// oxlint-disable-next-line eslint/no-control-regex -- HTTP cookie attributes cannot contain control characters.
const COOKIE_CONTROL = /[\u0000-\u001F\u007F]/u;

const INTEGER = /^-?\d+$/u;

const defaultPath = (url: URL): string => {
  const lastSlash = url.pathname.lastIndexOf("/");

  return lastSlash <= 0 ? "/" : url.pathname.slice(0, lastSlash);
};

const domainScope = (
  value: string | undefined,
  url: URL,
): Pick<SeedCookie, "domain"> | Pick<SkippedCookie, "reason"> => {
  if (value === undefined) {
    return { domain: undefined };
  }

  const domain = value.replace(/^\.+/u, "").toLowerCase();
  const parsed = URL.parse(`http://${domain}`);

  const matches =
    parsed !== null &&
    parsed.hostname === domain &&
    parsed.host === domain &&
    parsed.pathname === "/" &&
    (url.hostname === domain || url.hostname.endsWith(`.${domain}`));

  if (!matches) {
    return { reason: "domain-mismatch" };
  }

  if (getPublicSuffix(domain, { allowPrivateDomains: true }) !== domain) {
    return { domain: `.${domain}` };
  }

  return url.hostname === domain ? { domain: undefined } : { reason: "public-suffix-domain" };
};

const PREFIX_RULES = [
  { prefix: "__host-http-", requiresHostScope: true, requiresHttpOnly: true },
  { prefix: "__host-", requiresHostScope: true, requiresHttpOnly: false },
  { prefix: "__http-", requiresHostScope: false, requiresHttpOnly: true },
  { prefix: "__secure-", requiresHostScope: false, requiresHttpOnly: false },
] as const;

const meetsPrefixRules = ({ name, secure, httpOnly, domain, path }: SeedCookie): boolean => {
  const lowered = name.toLowerCase();
  const rule = PREFIX_RULES.find(({ prefix }) => lowered.startsWith(prefix));

  if (rule === undefined) {
    return true;
  }

  const hostScoped = domain === undefined && path === "/";

  return secure && (httpOnly || !rule.requiresHttpOnly) && (hostScoped || !rule.requiresHostScope);
};

const STORAGE_RULES: readonly {
  readonly reason: SkipReason;
  readonly holds: (cookie: SeedCookie) => boolean;
}[] = [
  { holds: meetsPrefixRules, reason: "prefix-rules" },
  {
    holds: ({ name, value }) => name.length + value.length <= MAX_NAME_VALUE_LENGTH,
    reason: "too-large",
  },
  { holds: ({ path }) => path.length <= MAX_PATH_LENGTH, reason: "path-too-long" },
  {
    holds: ({ sameSite, secure }) => sameSite !== "None" || secure,
    reason: "same-site-none-insecure",
  },
];

const SAME_SITE = new Map<string, SeedCookie["sameSite"]>([
  ["strict", "Strict"],
  ["lax", "Lax"],
  ["none", "None"],
]);

const cookieLifetime = (
  fields: ReadonlyMap<string, string>,
): Pick<SeedCookie, "expires" | "maxAge"> => {
  const maxAge = fields.get("max-age");

  if (maxAge !== undefined && INTEGER.test(maxAge)) {
    const seconds = Number(maxAge);

    return { expires: undefined, maxAge: Math.max(0, Math.min(seconds, Number.MAX_SAFE_INTEGER)) };
  }

  const expires = fields.get("expires");
  const expiry = expires === undefined ? Number.NaN : Date.parse(expires) / 1000;

  return { expires: Number.isFinite(expiry) ? Math.max(0, expiry) : undefined, maxAge: undefined };
};

const attributeName = (attribute: string): string => {
  const equal = attribute.indexOf("=");

  return (equal === -1 ? attribute : attribute.slice(0, equal)).trim().toLowerCase();
};

const parseCookie = (raw: string, url: URL): SeedCookie | SkippedCookie => {
  if (COOKIE_CONTROL.test(raw)) {
    throw invalidOptions("cookies contains an invalid Set-Cookie string.");
  }

  const [pair = "", ...attributes] = raw.split(";");
  const separator = pair.indexOf("=");
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();

  if (separator < 1 || !COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) {
    throw invalidOptions("cookies contains an invalid Set-Cookie string.");
  }

  const fields = new Map<string, string>();

  for (const attribute of attributes) {
    const equal = attribute.indexOf("=");

    fields.set(attributeName(attribute), equal === -1 ? "" : attribute.slice(equal + 1).trim());
  }

  const scope = domainScope(fields.get("domain"), url);

  if ("reason" in scope) {
    return { name, reason: scope.reason };
  }

  const path = fields.get("path");
  const sameSite = fields.get("samesite")?.toLowerCase();

  const setCookieHeader =
    scope.domain === undefined
      ? [pair, ...attributes.filter((attribute) => attributeName(attribute) !== "domain")].join(";")
      : raw;

  const cookie: SeedCookie = {
    domain: scope.domain,
    ...cookieLifetime(fields),
    httpOnly: fields.has("httponly"),
    name,
    path: path?.startsWith("/") === true ? path : defaultPath(url),
    sameSite: sameSite === undefined ? undefined : SAME_SITE.get(sameSite),
    secure: fields.has("secure"),
    setCookieHeader,
    url: url.href,
    value,
  };

  const unmet = STORAGE_RULES.find(({ holds }) => !holds(cookie));

  return unmet === undefined ? cookie : { name, reason: unmet.reason };
};

export const reportSkippedCookies = (skipped: readonly SkippedCookie[]): void => {
  for (const { name, reason } of skipped) {
    publishInternalEvent({ detail: JSON.stringify({ name, reason }), event: "cookie-skipped" });
  }
};

export const parseSeedCookies = (value: ScrapeOptions["cookies"], url: URL): CookieSeeds => {
  if (value === undefined) {
    return { seeds: [], skipped: [] };
  }

  if (!Array.isArray(value)) {
    throw invalidOptions("cookies must be an array of Set-Cookie strings.");
  }

  const seeds: SeedCookie[] = [];
  const skipped: SkippedCookie[] = [];

  for (const raw of value) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Public JavaScript cookie options are untrusted.
    if (typeof raw !== "string") {
      throw invalidOptions("cookies must be an array of Set-Cookie strings.");
    }

    const cookie = parseCookie(raw, url);

    if ("reason" in cookie) {
      skipped.push(cookie);
    } else {
      seeds.push(cookie);
    }
  }

  return { seeds, skipped };
};
