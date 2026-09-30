import { XrioError } from "../errors.ts";
import type { Engine } from "../scrape/types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpEngineOptions {
  /** Injectable for tests; defaults to the platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** The plain GET mode: follows redirects and returns whatever status the site answered with. */
export const createHttpEngine = ({
  fetch: fetchPage = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: HttpEngineOptions = {}): Engine => ({
  fetch: async (request, route) => {
    // Sending the request unproxied would silently leak the caller's own IP, so refuse instead.
    if (route.proxyUrl !== undefined) {
      throw new XrioError(
        "engine_unavailable",
        'The "http" engine cannot honor proxies yet; a route supplied a proxyUrl.',
      );
    }

    try {
      const response = await fetchPage(request.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });

      return {
        finalUrl: response.url === "" ? request.url : response.url,
        html: await response.text(),
        status: response.status,
      };
    } catch (error) {
      throw new XrioError("fetch_failed", `Failed to fetch ${request.url}`, { cause: error });
    }
  },
  mode: "http",
});
