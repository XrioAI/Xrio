import { redactUrl, XrioError } from "../errors.ts";

const CERTIFICATE_ERROR = /(?:net::)?ERR_CERT_|CERTIFICATE_VERIFY_FAILED/u;

const REDIRECT_ERROR = /(?:net::)?ERR_TOO_MANY_REDIRECTS/u;

const CHROME_NET_ERROR = /^net::ERR_[A-Z0-9_]+$/u;

export const networkFailure = (url: URL, netError: string, cause?: unknown): XrioError => {
  const message = `Loading ${redactUrl(url)} failed with ${netError}.`;

  if (CERTIFICATE_ERROR.test(netError)) {
    return new XrioError("TLS_CERTIFICATE_INVALID", message, { cause, details: undefined });
  }

  if (REDIRECT_ERROR.test(netError)) {
    return new XrioError("TOO_MANY_REDIRECTS", message, { cause, details: undefined });
  }

  return new XrioError("NETWORK_ERROR", message, {
    cause,
    details: CHROME_NET_ERROR.test(netError) ? { netError } : undefined,
  });
};
