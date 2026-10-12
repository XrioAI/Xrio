import { randomInt } from "node:crypto";

import type { Deadline } from "../deadline.ts";
import { invalidOptions, XrioError } from "../errors.ts";
import { resolveProxyConfig, SESSION_PLACEHOLDER } from "./config.ts";
import type { ProxyConfig } from "./config.ts";
import { lookupProxyInfo } from "./info.ts";
import type { ProxyInfo } from "./info.ts";

export type RotationSignal =
  | "success"
  | "blocked"
  | "transient_connection_failure"
  | "other_failure";

const ALPHABETS = {
  alphanumeric: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  numeric: "0123456789",
} as const;

const MAX_SESSION_ATTEMPTS = 100;

const DEFAULT_SESSION_ID_LENGTH = 8;

export class ProxyManager {
  // Runtime-private state; callers interact only through the public methods below.
  readonly #config: ProxyConfig;
  readonly #connections = new Set<string>();
  #connection: string;

  public constructor(config: ProxyConfig) {
    this.#config = resolveProxyConfig(config);
    this.#connection = this.#config.url;

    if (this.#config.session === undefined) {
      this.#connections.add(this.#connection);
    } else {
      this.changeSession();
    }
  }

  public createSessionId(): string {
    const { session } = this.#config;
    const alphabet = ALPHABETS[session?.format ?? "numeric"];

    return Array.from(
      { length: session?.length ?? DEFAULT_SESSION_ID_LENGTH },
      () => alphabet[randomInt(alphabet.length)],
    ).join("");
  }

  public connectionFor(stickyId: string): string {
    return this.#config.url.replace(SESSION_PLACEHOLDER, stickyId);
  }

  public get managesSessions(): boolean {
    return this.#config.session !== undefined;
  }

  public getProxyConnectionString(): string {
    return this.#connection;
  }

  public async getProxyInfo(connectionString: string, deadline: Deadline): Promise<ProxyInfo> {
    if (!this.#connections.has(connectionString)) {
      throw invalidOptions("Proxy information requires a connection issued by this manager.");
    }

    return await lookupProxyInfo(connectionString, deadline);
  }

  /** Checks whether rotation is warranted without changing the session. */
  public shouldRotateSession(connectionString: string, outcome: RotationSignal): boolean {
    const eligibleFailure = outcome === "blocked" || outcome === "transient_connection_failure";

    return (
      eligibleFailure && connectionString === this.#connection && this.#config.session !== undefined
    );
  }

  public changeSession(): string {
    if (this.#config.session === undefined) {
      throw invalidOptions(
        "Session rotation is not configured; proxy.url needs a {session} placeholder.",
      );
    }

    // ponytail: bound collision retries; increase session.length if the ID space fills.
    for (let attempt = 0; attempt < MAX_SESSION_ATTEMPTS; attempt += 1) {
      const connection = this.connectionFor(this.createSessionId());

      if (!this.#connections.has(connection)) {
        this.#connections.add(connection);
        this.#connection = connection;

        return connection;
      }
    }

    throw new XrioError(
      "PROXY_SESSION_GENERATION_FAILED",
      "Could not generate an unused proxy session; increase proxy.session.length.",
      { details: undefined },
    );
  }
}
