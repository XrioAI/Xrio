import { randomInt } from "node:crypto";

import { loadXrioConfig } from "../config.ts";
import { invalidOptions } from "../errors.ts";
import { resolveProxyConfig, SESSION_PLACEHOLDER } from "./config.ts";
import type { ProxyConfig } from "./config.ts";
import { lookupProxyInfo } from "./info.ts";
import type { ProxyInfo } from "./info.ts";

export type ScrapeOutcome =
  | "success"
  | "blocked"
  | "transient_connection_failure"
  | "other_failure";

const ALPHABETS = {
  alphanumeric: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numeric: "0123456789",
} as const;

const MAX_SESSION_ATTEMPTS = 100;

export class ProxyManager {
  // Runtime-private state; callers interact only through the public methods below.
  readonly #config: ProxyConfig;
  readonly #connections = new Set<string>();
  #connection: string;

  public constructor(config: ProxyConfig | undefined = loadXrioConfig().proxy) {
    this.#config = resolveProxyConfig(config);
    this.#connection = this.#config.url;

    if (this.#config.session === undefined) {
      this.#connections.add(this.#connection);
    } else {
      this.change_session();
    }
  }

  public get_proxy_connection_string(): string {
    return this.#connection;
  }

  public async get_proxy_info(connection_string: string, signal?: AbortSignal): Promise<ProxyInfo> {
    if (!this.#connections.has(connection_string)) {
      throw invalidOptions("Proxy information requires a connection issued by this manager.");
    }

    return await lookupProxyInfo(connection_string, signal);
  }

  /** Checks whether rotation is warranted without changing the session. */
  public should_rotate_session(connection_string: string, outcome: ScrapeOutcome): boolean {
    const eligibleFailure = outcome === "blocked" || outcome === "transient_connection_failure";

    return (
      eligibleFailure &&
      connection_string === this.#connection &&
      this.#config.session !== undefined
    );
  }

  public change_session(): string {
    const { session, url } = this.#config;

    if (session === undefined) {
      throw invalidOptions(
        "Session rotation is not configured; proxy.url needs a {session} placeholder.",
      );
    }

    const alphabet = ALPHABETS[session.format ?? "numeric"];
    const length = session.length ?? 8;

    // ponytail: bound collision retries; increase session.length if the ID space fills.
    for (let attempt = 0; attempt < MAX_SESSION_ATTEMPTS; attempt += 1) {
      const id = Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
      const connection = url.replace(SESSION_PLACEHOLDER, id);

      if (!this.#connections.has(connection)) {
        this.#connections.add(connection);
        this.#connection = connection;

        return connection;
      }
    }

    throw new Error("Could not generate an unused proxy session; increase proxy.session.length.");
  }
}
