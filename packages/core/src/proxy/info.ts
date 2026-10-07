/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This module parses untrusted geolocation responses into complete ProxyInfo values. */
import { isIP } from "node:net";

import { createSession } from "wreq-js";

import { startDeadline, untilDeadline } from "../deadline.ts";
import type { Deadline } from "../deadline.ts";
import { isXrioError, XrioError } from "../errors.ts";
import { parseProxy } from "../options.ts";
import { startRelay } from "../relay/relay.ts";

export interface ProxyInfo {
  exitIp: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  /** IANA time zone reported for the observed exit IP. */
  timezone: string;
  /** Likely locale inferred from country, not an observed language preference. */
  locale: string;
}

const EXIT_BUDGET_MS = 5000;

const PRIMARY_BUDGET_MS = EXIT_BUDGET_MS / 2;

// ISO 3166-1 alpha-2 codes from IANA tzdata's public-domain iso3166.tab (2025-07-01).
const COUNTRY_CODES = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  ),
);

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });

const normalizedCountryName = (name: string): string =>
  name
    .normalize("NFKD")
    .replaceAll(/\p{Mark}/gu, "")
    .toLowerCase()
    .replaceAll("&", "and")
    .replaceAll(/[^a-z]/gu, "");

const countryCodesByName = new Map(
  [...COUNTRY_CODES].map((code) => [normalizedCountryName(countryNames.of(code) ?? ""), code]),
);

const proxyInfo = (ip: unknown, country: unknown, timezone: unknown): ProxyInfo | undefined => {
  if (
    typeof ip !== "string" ||
    isIP(ip) === 0 ||
    typeof country !== "string" ||
    !COUNTRY_CODES.has(country) ||
    typeof timezone !== "string" ||
    /^[+-]/u.test(timezone)
  ) {
    return undefined;
  }

  try {
    // Validate a named time zone, rather than accepting a raw UTC offset.
    new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions();
    const inferred = new Intl.Locale(`und-${country}`).maximize().minimize();
    const locale = new Intl.Locale(inferred, { region: country }).toString();

    return { country, exitIp: ip, locale, timezone };
  } catch {
    return undefined;
  }
};

const fromIpWho = (body: unknown): ProxyInfo | undefined => {
  if (
    typeof body !== "object" ||
    body === null ||
    !("success" in body) ||
    body.success !== true ||
    !("ip" in body) ||
    !("country_code" in body) ||
    !("timezone" in body)
  ) {
    return undefined;
  }

  const { timezone } = body;

  if (typeof timezone !== "object" || timezone === null || !("id" in timezone)) {
    return undefined;
  }

  return proxyInfo(body.ip, body.country_code, timezone.id);
};

const fromIpApi = (body: unknown): ProxyInfo | undefined => {
  if (
    typeof body !== "object" ||
    body === null ||
    !("is_bogon" in body) ||
    body.is_bogon !== false ||
    !("ip" in body) ||
    !("country" in body) ||
    typeof body.country !== "string" ||
    !("timezone" in body)
  ) {
    return undefined;
  }

  const country = countryCodesByName.get(normalizedCountryName(body.country));

  return proxyInfo(body.ip, country, body.timezone);
};

const services = [
  { parse: fromIpWho, timeoutMs: PRIMARY_BUDGET_MS, url: "https://ipwho.is/" },
  { parse: fromIpApi, timeoutMs: EXIT_BUDGET_MS, url: "https://api.ipapi.is/" },
];

const requestProxyJson = async (
  url: string,
  connection: string,
  deadline: Deadline,
): Promise<{ status: number; body: unknown }> => {
  await using relay = await startRelay(parseProxy(connection), deadline);

  try {
    await using session = await createSession({ proxy: relay.url, timeout: 0 });
    // Fixed HTTPS endpoints only; rejecting redirects also prevents a redirect to a local target.
    const response = await session.fetch(url, { redirect: "error", signal: deadline.signal });

    return { body: response.ok ? await response.json() : undefined, status: response.status };
  } catch (error) {
    throw relay.failureFor(new URL(url).hostname) ?? error;
  }
};

export const lookupProxyInfo = async (
  connection: string,
  deadline: Deadline,
  requestJson = requestProxyJson,
): Promise<ProxyInfo> => {
  deadline.throwIfExpired();
  using budget = deadline.startStage(EXIT_BUDGET_MS);

  for (const service of services) {
    deadline.throwIfExpired();

    if (budget.signal.aborted) {
      break;
    }

    using attempt = startDeadline(service.timeoutMs, budget.signal);

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- only call the fallback when the primary fails.
      const response = await untilDeadline(
        async () => await requestJson(service.url, connection, attempt),
        attempt,
      );

      deadline.throwIfExpired();
      attempt.throwIfExpired();

      const info =
        response.status >= 200 && response.status < 300 ? service.parse(response.body) : undefined;

      if (info !== undefined) {
        return info;
      }
    } catch (error) {
      deadline.throwIfExpired();

      if (isXrioError(error, "PROXY_AUTH_FAILED") || isXrioError(error, "PROXY_UNREACHABLE")) {
        throw error;
      }

      // Other request errors may contain credentials; do not expose them as causes.
    }
  }

  throw new XrioError(
    "PROXY_INFO_UNAVAILABLE",
    "Could not obtain complete proxy information from ipwho.is or ipapi.is.",
    { details: undefined },
  );
};
