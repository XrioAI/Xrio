import type { AttemptLog } from "../sources/visit.ts";

export const attemptLog = (overrides: Partial<AttemptLog> = {}): AttemptLog => ({
  argv: null,
  challengeOutcome: null,
  challengeRules: [],
  deviceDigest: null,
  errorCode: null,
  exitAddress: null,
  outcome: "ok",
  plan: null,
  proxyUrl: null,
  site: "example.com",
  status: 200,
  url: "https://example.com/",
  vendor: null,
  ...overrides,
});
