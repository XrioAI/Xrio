import { setImmediate as nextTurn } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import {
  CHALLENGE,
  challengeHeaders,
  CONTENT,
  documentHop,
  PAGE_URL,
  startedRender,
} from "../../testing/manual-render.ts";
import type { DocumentHop, DriverEvent } from "./port.ts";

const served = (index: number, overrides: Partial<DocumentHop> = {}): DocumentHop =>
  documentHop({ loaderId: `L${index}`, requestId: `R${index}`, ...overrides });

const challenged = (index: number, vendorHeader = "cf-mitigated"): DocumentHop =>
  served(index, { headers: challengeHeaders(vendorHeader) });

const CLOUDFLARE_ROUND = { rule: "cf_mitigated_challenge", vendor: "cloudflare" } as const;

const LATE_ROUND = { rule: "cf_challenge_platform_request", vendor: "cloudflare" } as const;

const CHALLENGE_SCRIPT_URL = `${PAGE_URL}cdn-cgi/challenge-platform/h/g/orchestrate/test`;

const requestChallengeScript = (document: DocumentHop): DriverEvent => ({
  ...document,
  type: "request",
  url: CHALLENGE_SCRIPT_URL,
});

describe("challenge waits", () => {
  it("withholds a late challenge request on a served page without waiting", async () => {
    const first = served(1);
    const run = startedRender(first);
    using _deadline = run.deadline;
    run.onCapture(() => {
      run.emit({ ...first, type: "request", url: "https://geo.captcha-delivery.com/captcha/" });
    });
    const { source } = await run.result;
    expect(source.block.challenge).toBeNull();
    expect(source.block.passedChallenges).toContain("datadome_captcha_delivery_request");
    expect(source.html).toBe(CONTENT);
    expect(run.time.clock.now()).toBe(0);
  });

  it("binds a pass during capture to the replacement's response", async () => {
    const run = startedRender(challenged(1));
    using _deadline = run.deadline;
    await nextTurn();
    run.onCapture(() => {
      run.commit(served(2, { status: 201 }));
    });
    await run.tick(20_000);
    const { source } = await run.result;
    expect(source.status).toBe(201);
    expect(source.html).toBe(CONTENT);
    expect(source.block.challenge?.outcome).toBe("passed");
  });

  it("reports a passed header challenge with only the replacement's request log", async () => {
    const first = challenged(1);
    const run = startedRender(first);
    using _deadline = run.deadline;
    await nextTurn();
    run.emit(requestChallengeScript(first));
    run.commit(served(2));
    await run.tick();
    const { source } = await run.result;
    expect(source.block.challenge).toStrictEqual({
      outcome: "passed",
      rounds: [{ ...CLOUDFLARE_ROUND, waitedMs: 250 }],
    });
    expect(source.requestUrls).toStrictEqual([]);
    expect(source.block.verdict).toBe("ok");
    expect(run.listeners()).toBe(0);
  });

  it.each([
    {
      name: "same vendor",
      rounds: [CLOUDFLARE_ROUND, CLOUDFLARE_ROUND],
      second: "cf-mitigated",
    },
    {
      name: "two vendors",
      rounds: [CLOUDFLARE_ROUND, { rule: "datadome_response_header", vendor: "datadome" }],
      second: "x-datadome-response",
    },
  ])("waits for each document in a $name chain", async ({ second, rounds }) => {
    const run = startedRender(challenged(1));
    using _deadline = run.deadline;
    await nextTurn();
    run.commit(challenged(2, second));
    await run.tick();
    run.commit(served(3));
    await run.tick();
    const { source } = await run.result;
    expect(source.block.challenge).toStrictEqual({
      outcome: "passed",
      rounds: rounds.map((round) => ({ ...round, waitedMs: 250 })),
    });
  });

  it("judges a loaded replacement on a poll tick, including its late challenge request", async () => {
    const run = startedRender(challenged(1));
    using _deadline = run.deadline;
    await nextTurn();
    const second = served(2);
    run.commit(second, CHALLENGE);
    run.emit({ ...second, type: "request", url: "https://geo.captcha-delivery.com/captcha/" });
    await run.tick();
    run.commit(served(3));
    await run.tick();
    const { source } = await run.result;
    expect(source.block.challenge?.rounds.map(({ vendor }) => vendor)).toStrictEqual([
      "cloudflare",
      "datadome",
    ]);
  });

  it("captures an in-place pass after the round ends, under the challenge response's status", async () => {
    const run = startedRender(
      served(1, { headers: challengeHeaders("cf-mitigated"), status: 403 }),
    );

    using _deadline = run.deadline;
    await nextTurn();
    run.setHtml(CONTENT);
    await run.tick(20_000);
    const { source } = await run.result;
    expect(source.block.challenge?.outcome).toBe("passed_in_place");
    expect(source.status).toBe(403);
    expect(source.html).toBe(CONTENT);
  });

  it.each([
    { outcome: "budget_exhausted", timeoutMs: 60_000, wait: 20_000 },
    { outcome: "deadline", timeoutMs: 3000, wait: 2000 },
  ])("reports $outcome and leaves a capture reserve", async ({ timeoutMs, wait, outcome }) => {
    const run = startedRender(challenged(1), timeoutMs);
    using _deadline = run.deadline;
    await nextTurn();
    await run.tick(wait);
    const { source } = await run.result;
    expect(source.block.challenge?.outcome).toBe(outcome);
    expect(run.deadline.remainingMs()).toBeGreaterThanOrEqual(1000);
  });

  it("fails at the next tick when a challenge gives way to a document without an HTTP response", async () => {
    const run = startedRender(challenged(1));
    using _deadline = run.deadline;

    const settled = (async () => {
      try {
        await run.result;
      } catch (error) {
        return { at: run.time.clock.now(), error };
      }

      return { at: run.time.clock.now(), error: null };
    })();

    await nextTurn();
    const blank = served(2);
    run.emit({ ...blank, type: "commit" });
    run.emit({ ...blank, type: "dom-content-loaded" });
    await run.tick(250);
    await run.tick(19_750);
    await expect(settled).resolves.toMatchObject({
      at: 250,
      error: {
        code: "NETWORK_ERROR",
        message: "The page committed a document that had no HTTP response.",
      },
    });
  });

  it("stops after three rounds when a fourth challenge commits", async () => {
    const run = startedRender(challenged(1));
    using _deadline = run.deadline;
    await nextTurn();
    run.commit(challenged(2));
    await run.tick();
    run.commit(challenged(3));
    await run.tick();
    run.commit(challenged(4));
    await run.tick();
    const { source } = await run.result;
    expect(source.block.challenge).toMatchObject({
      outcome: "rounds_exhausted",
      rounds: [{ waitedMs: 250 }, { waitedMs: 250 }, { waitedMs: 250 }],
    });
  });

  it("waits once more for a challenge discovered during capture, then returns the recaptured document", async () => {
    const first = served(1);
    const run = startedRender(first);
    using _deadline = run.deadline;
    run.setHtml(CHALLENGE);
    run.onCapture(() => {
      run.emit(requestChallengeScript(first));
    });
    await nextTurn();
    run.commit(served(2));
    await run.tick();
    const { source } = await run.result;
    expect(source.block.challenge).toStrictEqual({
      outcome: "passed",
      rounds: [{ ...LATE_ROUND, waitedMs: 250 }],
    });
    expect(source.html).toBe(CONTENT);
  });
});

describe("settling the challenge outcome", () => {
  it("reports rounds_exhausted when the capture after a passed late wait is still a challenge", async () => {
    const first = served(1);
    const second = served(2);
    const run = startedRender(first);
    using _deadline = run.deadline;
    run.setHtml(CHALLENGE);
    run.onCapture(() => {
      run.emit(requestChallengeScript(first));
    });
    await nextTurn();
    run.commit(second, CHALLENGE);
    run.onCapture(() => {
      run.emit(requestChallengeScript(second));
    });
    await run.tick();
    const { source } = await run.result;
    expect(source.block.challenge).toStrictEqual({
      outcome: "rounds_exhausted",
      rounds: [{ ...LATE_ROUND, waitedMs: 250 }],
    });
    expect(source.block.verdict).toBe("blocked");
  });
});
