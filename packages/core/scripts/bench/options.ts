import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

export interface BenchOptions {
  readonly mode: "headless" | "headed";
  readonly out: string | undefined;
  readonly route: string;
  readonly runs: number;
  readonly warmup: number;
  readonly liveUrls: readonly string[] | undefined;
  readonly proxy: string | undefined;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;

const PROXY_REFERENCE = /^env:(?<name>[A-Za-z_][A-Za-z0-9_]*)$/u;

const parseMode = (value: string): "headless" | "headed" => {
  if (value !== "headless" && value !== "headed") {
    throw new Error(`--mode must be headless or headed, not "${value}".`);
  }

  return value;
};

const parseCount = (flag: string, value: string, least: number): number => {
  const count = Number(value);

  if (!Number.isInteger(count) || count < least) {
    throw new Error(`--${flag} must be an integer of at least ${least}, not "${value}".`);
  }

  return count;
};

const readProxy = (reference: string | undefined): string | undefined => {
  if (reference === undefined) {
    return undefined;
  }

  const name = PROXY_REFERENCE.exec(reference)?.groups?.name;

  if (name === undefined) {
    throw new Error(`--proxy must be env:NAME, not "${reference}".`);
  }

  const proxy = process.env[name];

  if (proxy === undefined || proxy === "") {
    throw new Error(`--proxy names $${name}, which is not set.`);
  }

  return URL_SCHEME.test(proxy) ? proxy : `http://${proxy}`;
};

const readLiveUrls = async (file: string): Promise<string[]> => {
  const listing = await readFile(file, "utf-8");

  const urls = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (urls.length === 0) {
    throw new Error(`--urls ${file} lists no URLs.`);
  }

  return urls.map((url) => new URL(url).href);
};

const requireLiveRoute = (proxy: string | undefined): void => {
  if (process.platform !== "linux") {
    throw new Error("--urls runs live pages, which only run on the Linux host.");
  }

  if (proxy === undefined) {
    throw new Error("--urls needs --proxy env:NAME so live pages never leave from this host's IP.");
  }
};

export const readBenchOptions = async (): Promise<BenchOptions> => {
  const { values } = parseArgs({
    options: {
      mode: { default: "headless", type: "string" },
      out: { type: "string" },
      proxy: { type: "string" },
      route: { default: "/static", type: "string" },
      runs: { default: "10", type: "string" },
      urls: { type: "string" },
      warmup: { default: "1", type: "string" },
    },
  });

  const proxy = readProxy(values.proxy);

  if (values.urls !== undefined) {
    requireLiveRoute(proxy);
  }

  return {
    liveUrls: values.urls === undefined ? undefined : await readLiveUrls(values.urls),
    mode: parseMode(values.mode),
    out: values.out,
    proxy,
    route: values.route,
    runs: parseCount("runs", values.runs, 1),
    warmup: parseCount("warmup", values.warmup, 0),
  };
};
