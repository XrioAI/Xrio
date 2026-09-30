import { XrioError, definePlugin } from "@xrio/core";
import type { Plugin } from "@xrio/core";

import { startApiServer } from "./server.ts";
import type { ApiServer } from "./server.ts";

const DEFAULT_HOST = "127.0.0.1";

const DEFAULT_PORT = 3000;

const MAX_PORT = 65_535;

export interface HttpApiOptions {
  /** Default: 3000. Use 0 to let the OS pick a free port. */
  readonly port?: number;
  /** Default: 127.0.0.1, so the API is not exposed to the network by accident. */
  readonly host?: string;
  /** Serve the Swagger UI at `/docs` and the OpenAPI document at `/docs.json`. Default: true. */
  readonly docs?: boolean;
}

export interface HttpApiPlugin extends Plugin {
  /** Where the API listens, once Xrio has started. */
  readonly url: string | undefined;
  /** Where the Swagger UI is served, once Xrio has started and `docs` is on. */
  readonly docsUrl: string | undefined;
}

/** Serves `POST /scrape` over HTTP, plus Swagger docs. Using the plugin is what turns the API on. */
export const httpApiPlugin = ({
  docs = true,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
}: HttpApiOptions = {}): HttpApiPlugin => {
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new XrioError("invalid_config", `"port" must be an integer from 0 to ${MAX_PORT}.`);
  }

  let server: ApiServer | undefined;

  const plugin = definePlugin({
    hooks: {
      start: async ({ logger, scrape }) => {
        server = await startApiServer({ docs, host, logger, port, scrape });
        logger.info("http server listening", {
          docs: docs ? `${server.url}/docs` : "off",
          url: server.url,
        });
      },
      stop: async () => {
        await server?.close();
        server = undefined;
      },
    },
    name: "http-api",
  });

  return {
    ...plugin,
    get docsUrl() {
      return server && docs ? `${server.url}/docs` : undefined;
    },
    get url() {
      return server?.url;
    },
  };
};
