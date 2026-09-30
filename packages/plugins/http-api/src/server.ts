import { once } from "node:events";
import type { Server } from "node:http";

import { XrioError } from "@xrio/core";
import type { Logger, ScrapeInput, ScrapeResult, XrioErrorCode } from "@xrio/core";
import express from "express";
import type { ErrorRequestHandler, Express, Response } from "express";
import swaggerUi from "swagger-ui-express";

import { buildOpenApiDocument } from "./openapi.ts";

/** Caught values can be anything; this is the single place they become an `Error`. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch clause hands us `unknown`
const toError = (caught: unknown): Error =>
  caught instanceof Error ? caught : new Error(String(caught), { cause: caught });

const SCRAPE_PATH = "/scrape";

const DOCS_PATH = "/docs";

const DOCS_JSON_PATH = "/docs.json";

const MAX_BODY = "1mb";

const HTTP_OK = 200;

const HTTP_BAD_REQUEST = 400;

const HTTP_NOT_FOUND = 404;

const HTTP_METHOD_NOT_ALLOWED = 405;

const HTTP_INTERNAL_ERROR = 500;

const HTTP_NOT_IMPLEMENTED = 501;

const HTTP_BAD_GATEWAY = 502;

const STATUS_BY_ERROR_CODE: Partial<Record<XrioErrorCode, number>> = {
  engine_unavailable: HTTP_NOT_IMPLEMENTED,
  fetch_failed: HTTP_BAD_GATEWAY,
  format_unsupported: HTTP_NOT_IMPLEMENTED,
  invalid_request: HTTP_BAD_REQUEST,
};

export interface ApiServerOptions {
  readonly host: string;
  readonly port: number;
  readonly docs: boolean;
  readonly logger: Logger;
  /** Receives the parsed JSON body exactly as sent; Xrio validates it before doing anything. */
  readonly scrape: (input: ScrapeInput) => Promise<ScrapeResult>;
}

export interface ApiServer {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const sendJsonError = (response: Response, status: number, code: string, message: string): void => {
  response.status(status).json({ error: { code, message } });
};

const sendScrapeError = (response: Response, error: Error, logger: Logger): void => {
  if (error instanceof XrioError) {
    const status = STATUS_BY_ERROR_CODE[error.code] ?? HTTP_INTERNAL_ERROR;
    sendJsonError(response, status, error.code, error.message);

    return;
  }

  logger.error("unexpected error while handling /scrape", { message: error.message });
  sendJsonError(response, HTTP_INTERNAL_ERROR, "internal_error", "Internal error.");
};

/** Body-parser failures (bad JSON, too large) carry the HTTP status they deserve. */
const bodyParserStatus = (error: Error): number | undefined =>
  "status" in error && Number.isInteger(error.status) ? Number(error.status) : undefined;

const handleBodyError =
  (logger: Logger): ErrorRequestHandler =>
  (error, _request, response, _next) => {
    const problem = toError(error);
    const status = bodyParserStatus(problem);

    if (status === undefined) {
      sendScrapeError(response, problem, logger);

      return;
    }

    sendJsonError(
      response,
      status,
      "invalid_request",
      "Request body must be valid JSON under 1mb.",
    );
  };

/** Never rejects: every failure becomes an HTTP error response. */
const respondToScrape = async (
  body: ScrapeInput,
  response: Response,
  { logger, scrape }: ApiServerOptions,
): Promise<void> => {
  try {
    const result = await scrape(body);
    response.status(HTTP_OK).type(result.contentType).send(result.content);
  } catch (error) {
    sendScrapeError(response, toError(error), logger);
  }
};

const mountDocs = (app: Express): void => {
  const document = buildOpenApiDocument();
  app.get(DOCS_JSON_PATH, (_request, response) => {
    response.json(document);
  });
  app.use(DOCS_PATH, swaggerUi.serve, swaggerUi.setup(document));
};

const buildApp = (options: ApiServerOptions): Express => {
  const { docs, logger } = options;
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.on("finish", () => {
      logger.debug("http request", {
        method: request.method,
        path: request.path,
        status: response.statusCode,
      });
    });
    next();
  });

  if (docs) {
    mountDocs(app);
  }

  app.post(
    SCRAPE_PATH,
    express.json({ limit: MAX_BODY, type: () => true }),
    (request, response) => {
      // oxlint-disable-next-line typescript/no-unsafe-argument -- Express types the body as any; Xrio validates it
      void respondToScrape(request.body, response, options);
    },
  );
  app.all(SCRAPE_PATH, (_request, response) => {
    sendJsonError(response, HTTP_METHOD_NOT_ALLOWED, "method_not_allowed", "Use POST /scrape.");
  });
  app.use((_request, response) => {
    sendJsonError(response, HTTP_NOT_FOUND, "not_found", "Not found. Use POST /scrape.");
  });
  app.use(handleBodyError(logger));

  return app;
};

const listen = async (server: Server, host: string): Promise<string> => {
  await once(server, "listening");
  const address = server.address();

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node types `address()` as AddressInfo | string | null
  if (address === null || typeof address === "string") {
    throw new Error("The API server is not listening on a TCP address.");
  }

  return `http://${host}:${address.port}`;
};

const closeServer = async (server: Server): Promise<void> => {
  server.close();
  server.closeAllConnections();
  await once(server, "close");
};

/** Serves `POST /scrape`, plus Swagger docs at `/docs` when enabled. */
export const startApiServer = async (options: ApiServerOptions): Promise<ApiServer> => {
  const server = buildApp(options).listen(options.port, options.host);
  const url = await listen(server, options.host);

  return {
    close: async () => {
      await closeServer(server);
    },
    url,
  };
};
