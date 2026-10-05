import { readFileSync } from "node:fs";

import { isXrioError, XrioClient } from "../src/client.ts";

const ALLOWED_MAJOR_LAG = 1;

const STABLE_VERSIONS_URL =
  "https://versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions?pageSize=1";

const TLS_EXTENSIONS_THE_PROFILE_LACKS = new Set(["ca34"]);

const SIGNATURE_ALGORITHMS_THE_PROFILE_LACKS = new Set(["0904", "0905", "0906"]);

interface HeadersPriority {
  weight: number;
  depends_on: number;
  exclusive: number;
}

interface WireIdentity {
  ja4R: string;
  http2Fingerprint: string;
  headersPriority: HeadersPriority;
  headerOrder: string[];
}

interface Capture extends WireIdentity {
  browser: string;
  echo: string;
}

interface HeadersFrame {
  frame_type: "HEADERS";
  headers: string[];
  priority: HeadersPriority;
}

interface Echo {
  tls: { ja4_r: string };
  http2: { akamai_fingerprint: string; sent_frames: unknown[] };
}

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number => typeof value === "number";

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isPriority = (value: unknown): value is HeadersPriority =>
  isObject(value) &&
  "weight" in value &&
  isNumber(value.weight) &&
  "depends_on" in value &&
  isNumber(value.depends_on) &&
  "exclusive" in value &&
  isNumber(value.exclusive);

const isCapture = (value: unknown): value is Capture =>
  isObject(value) &&
  "browser" in value &&
  isString(value.browser) &&
  "echo" in value &&
  isString(value.echo) &&
  "ja4R" in value &&
  isString(value.ja4R) &&
  "http2Fingerprint" in value &&
  isString(value.http2Fingerprint) &&
  "headersPriority" in value &&
  isPriority(value.headersPriority) &&
  "headerOrder" in value &&
  isStringList(value.headerOrder);

const isEcho = (value: unknown): value is Echo =>
  isObject(value) &&
  "tls" in value &&
  isObject(value.tls) &&
  "ja4_r" in value.tls &&
  isString(value.tls.ja4_r) &&
  "http2" in value &&
  isObject(value.http2) &&
  "akamai_fingerprint" in value.http2 &&
  isString(value.http2.akamai_fingerprint) &&
  "sent_frames" in value.http2 &&
  Array.isArray(value.http2.sent_frames);

const isHeadersFrame = (value: unknown): value is HeadersFrame =>
  isObject(value) &&
  "frame_type" in value &&
  value.frame_type === "HEADERS" &&
  "headers" in value &&
  isStringList(value.headers) &&
  "priority" in value &&
  isPriority(value.priority);

const isVersionEntry = (value: unknown): value is { version: string } =>
  isObject(value) && "version" in value && isString(value.version);

const isVersionList = (value: unknown): value is { versions: { version: string }[] } =>
  isObject(value) &&
  "versions" in value &&
  Array.isArray(value.versions) &&
  value.versions.every(isVersionEntry);

const headerName = (line: string) =>
  line.startsWith(":") ? `:${line.slice(1).split(":", 1)[0]}` : line.split(":", 1)[0];

const USER_AGENT_MAJOR = /Chrome\/(?<major>\d+)\./u;

const fetchEchoBody = async (echoUrl: string): Promise<string> => {
  try {
    const result = await new XrioClient().scrape({ format: "html", url: echoUrl });

    return result.data;
  } catch (error) {
    if (isXrioError(error, "UNSUPPORTED_CONTENT_TYPE")) {
      return error.details.body;
    }

    throw error;
  }
};

const captureProfileIdentity = async (
  echoUrl: string,
): Promise<WireIdentity & { chromeMajor: number }> => {
  const echo: unknown = JSON.parse(await fetchEchoBody(echoUrl));
  const headersFrame = isEcho(echo) ? echo.http2.sent_frames.find(isHeadersFrame) : undefined;

  if (!isEcho(echo) || headersFrame === undefined) {
    throw new Error("The echo service returned an unexpected body.");
  }

  const userAgent = headersFrame.headers.find((line) => line.startsWith("user-agent:")) ?? "";

  return {
    chromeMajor: Number(USER_AGENT_MAJOR.exec(userAgent)?.groups?.major),
    headerOrder: headersFrame.headers.map(headerName),
    headersPriority: headersFrame.priority,
    http2Fingerprint: echo.http2.akamai_fingerprint,
    ja4R: echo.tls.ja4_r,
  };
};

const stableChromeMajor = async (): Promise<number> => {
  const response = await fetch(STABLE_VERSIONS_URL);
  const body: unknown = await response.json();

  if (!isVersionList(body) || body.versions.length === 0) {
    throw new Error("The Chrome version history returned an unexpected body.");
  }

  return Number(body.versions[0].version.split(".", 1)[0]);
};

const withoutKnownGaps = (ja4R: string) => {
  const [, ciphers, extensions, signatureAlgorithms] = ja4R.split("_");

  return {
    ciphers,
    extensions: extensions
      .split(",")
      .filter((value) => !TLS_EXTENSIONS_THE_PROFILE_LACKS.has(value)),
    signatureAlgorithms: signatureAlgorithms
      .split(",")
      .filter((value) => !SIGNATURE_ALGORITHMS_THE_PROFILE_LACKS.has(value)),
  };
};

const compareIdentities = (chrome: WireIdentity, profile: WireIdentity): string[] => {
  const problems: string[] = [];
  const expectedTls = JSON.stringify(withoutKnownGaps(chrome.ja4R));

  if (JSON.stringify(withoutKnownGaps(profile.ja4R)) !== expectedTls) {
    problems.push(`TLS differs from Chrome beyond the known gaps: ${profile.ja4R}`);
  }

  if (profile.ja4R === chrome.ja4R) {
    problems.push("TLS now matches Chrome exactly: remove the known gaps from this check.");
  }

  for (const key of ["http2Fingerprint", "headersPriority", "headerOrder"] as const) {
    const expected = JSON.stringify(chrome[key]);
    const actual = JSON.stringify(profile[key]);

    if (actual !== expected) {
      problems.push(`${key} differs: Chrome ${expected}, profile ${actual}`);
    }
  }

  return problems;
};

const capture: unknown = JSON.parse(
  readFileSync(new URL("chrome-wire-capture.json", import.meta.url), "utf-8"),
);

if (!isCapture(capture)) {
  throw new Error("chrome-wire-capture.json does not describe a wire identity.");
}

const [profile, stableMajor] = await Promise.all([
  captureProfileIdentity(capture.echo),
  stableChromeMajor(),
]);

const problems = compareIdentities(capture, profile);

const isStale = !(stableMajor - profile.chromeMajor <= ALLOWED_MAJOR_LAG);

if (isStale) {
  problems.push(
    `The http profile is Chrome ${profile.chromeMajor}; Chrome stable is ${stableMajor}.`,
  );
}

process.stdout.write(
  `Compared http mode (Chrome ${profile.chromeMajor}) with ${capture.browser}.\n`,
);

for (const problem of problems) {
  process.stdout.write(`FAIL ${problem}\n`);
}

process.exitCode = problems.length === 0 ? 0 : 1;
