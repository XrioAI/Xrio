/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- This module is the runtime parser for untrusted proxy configuration. */
import { invalidOptions } from "../errors.ts";
import { parseProxy } from "../options.ts";

type SessionTemplate = `${string}{session}${string}`;

export const SESSION_FORMATS = ["numeric", "alphanumeric"] as const;

type SessionFormat = (typeof SESSION_FORMATS)[number];

interface SessionOptions {
  format?: SessionFormat;
  length?: number;
}

export type ProxyConfig =
  | { url: string; session?: never }
  | { url: SessionTemplate; session: SessionOptions };

export const SESSION_PLACEHOLDER = "{session}";

export const MAX_SESSION_LENGTH = 256;

const isSessionTemplate = (value: string): value is SessionTemplate =>
  value.includes(SESSION_PLACEHOLDER);

const sessionOptions = (value: unknown): Required<SessionOptions> => {
  if (value === undefined) {
    return { format: "numeric", length: 8 };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidOptions("proxy.session must be an object.");
  }

  const format = "format" in value && value.format !== undefined ? value.format : "numeric";
  const length = "length" in value && value.length !== undefined ? value.length : 8;

  const resolvedFormat = SESSION_FORMATS.find((candidate) => candidate === format);

  if (resolvedFormat === undefined) {
    throw invalidOptions("proxy.session.format must be numeric or alphanumeric.");
  }

  if (
    typeof length !== "number" ||
    !Number.isInteger(length) ||
    length < 1 ||
    length > MAX_SESSION_LENGTH
  ) {
    throw invalidOptions(
      `proxy.session.length must be an integer between 1 and ${MAX_SESSION_LENGTH}.`,
    );
  }

  if (Object.keys(value).some((key) => key !== "format" && key !== "length")) {
    throw invalidOptions(
      "proxy.session only supports format and length; session IDs are generated at runtime.",
    );
  }

  return { format: resolvedFormat, length };
};

export const resolveProxyConfig = (value: unknown): ProxyConfig => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("url" in value) ||
    typeof value.url !== "string"
  ) {
    throw invalidOptions("proxy must be one object with a url string.");
  }

  if (Object.keys(value).some((key) => key !== "url" && key !== "session")) {
    throw invalidOptions("proxy only supports url and session.");
  }

  const { url } = value;
  const endpoint = parseProxy(url);
  const placeholders = url.split(SESSION_PLACEHOLDER).length - 1;
  const options = "session" in value ? value.session : undefined;

  if (!isSessionTemplate(url)) {
    if (options !== undefined) {
      throw invalidOptions("proxy.session requires a literal {session} placeholder in proxy.url.");
    }

    return { url };
  }

  const { credentials } = endpoint;

  const inCredentials =
    credentials !== undefined &&
    (credentials.username.includes(SESSION_PLACEHOLDER) ||
      credentials.password.includes(SESSION_PLACEHOLDER));

  if (placeholders !== 1 || !inCredentials) {
    throw invalidOptions(
      "proxy.url must contain exactly one {session} placeholder, in its username or password.",
    );
  }

  return { session: sessionOptions(options), url };
};
