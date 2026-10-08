import { describe, expect, it } from "vite-plus/test";

import { createAdmission } from "./admission.ts";
import type { Admission } from "./admission.ts";
import { createAnswer } from "./answer.ts";
import { classifyResponse } from "./blocks/classify.ts";
import type { ResolvedConfig } from "./config.ts";
import { createScrapes } from "./coordinator.ts";
import { startDeadline, untilDeadline } from "./deadline.ts";
import { XrioError } from "./errors.ts";
import { httpIdentity } from "./humanizer/humanizer.ts";
import { HeldDeadline } from "./lifetime.ts";
import { parseProxy, resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { outcomeOf } from "./outcome.ts";
import type { lookupProxyInfo, ProxyObservation } from "./proxy/info.ts";
import { Slot } from "./slot.ts";
import type { Closed } from "./sources/browser/chrome-scope.ts";
import { loadHttpDocument } from "./sources/http.ts";
import type { Sources, Visit, VisitPlan } from "./sources/visit.ts";
import { startFakeHttpProxy } from "./testing/fake-proxies.ts";
import { fixedRandom } from "./testing/fixed-seed.ts";
import { startFixtureServer } from "./testing/fixture-server.ts";
import { manualClock } from "./testing/manual-clock.ts";
import { noPins } from "./testing/no-pins.ts";
import { proxyObservation } from "./testing/proxy-observation.ts";
import type { ProxyEndpoint, SourceDocument } from "./types.ts";

const intent = resolveScrapeIntent(
  { format: "html", url: "https://example.com" },
  resolveClientOptions({ mode: "http" }),
);

const browserIntent = {
  ...intent,
  source: { browserArgs: [], browserPath: "/browser", mode: "headless" },
} as const;

const documentFor = (html: string): SourceDocument => {
  const response = { cookies: [], headers: {}, status: 200, url: "https://example.com" };

  return {
    scriptsRan: false,
    ...response,
    block: classifyResponse({ html, requestUrls: [response.url], response }),
    html,
    identity: httpIdentity(noPins).report({ permittedCpus: 32, platform: "linux" }),
    requestUrls: [response.url],
  };
};

const firstDocument = documentFor("<p>First</p>");

const secondDocument = documentFor("<p>Second</p>");

interface HarnessOptions {
  readonly config?: Pick<ResolvedConfig, "proxy">;
  readonly proxyInfo?: typeof lookupProxyInfo;
  readonly sources?: Sources;
  readonly admission?: Admission;
  readonly visits?: readonly Visit[];
  readonly failureAt?: string;
  readonly revisit?: boolean;
  readonly cleanupFailure?: string;
  readonly throwOnStart?: boolean;
}

const harness = (options: HarnessOptions = {}) => {
  const events: string[] = [];
  const plans: VisitPlan[] = [];
  const fontLocales: string[] = [];
  const failure = new XrioError("NETWORK_ERROR", "The fake stage failed.", { details: undefined });
  const owner = new AbortController();
  let visitIndex = 0;
  let warmth = options.revisit ?? false;

  const stage = (name: string) => {
    events.push(name);

    if (options.failureAt === name || options.cleanupFailure === name) {
      throw failure;
    }
  };

  const scrapes = createScrapes({
    admission: options.admission ?? {
      close: () => {
        stage("admission-close");
      },
      slotFor: async (_source, held) => {
        stage("queue");
        held.throwIfExpired();

        return await Promise.resolve(
          new Slot(() => {
            stage("slot-release");
          }),
        );
      },
    },
    comparisonBinary: "/comparison",
    config: options.config,
    fonts: {
      claim: async (_binary, _capabilities, locale) => {
        fontLocales.push(locale);
        stage("plan");

        return await Promise.resolve({
          evidence: undefined,
          settle: async () => {
            await Promise.resolve();
          },
        });
      },
    },
    host: {
      snapshotFor: async (binary) => {
        stage("host");
        events.push(`binary:${binary ?? "none"}`);

        return await Promise.resolve({ permittedCpus: 32, platform: "linux" });
      },
    },
    proxyInfo: options.proxyInfo,
    random: fixedRandom,
    sessions: {
      hold: async (_intent, checks) => {
        stage("hold");

        return await Promise.resolve({
          [Symbol.asyncDispose]: async () => {
            stage("hold-release");
            await Promise.resolve();
          },
          bind: (deadline) => new HeldDeadline(deadline, owner.signal),
          device: { kind: "fresh", seed: checks.seed() },
          finish: async () => {
            stage("finish");
            warmth = false;
            await Promise.resolve();
          },
          revisitWanted: () => {
            stage("revisit-decision");

            return warmth;
          },
        });
      },
    },
    sources: {
      close: async () => {
        stage("sources-close");
        await options.sources?.close();
        await Promise.resolve();
      },
      start: (plan, slot, held) => {
        stage("start");
        plans.push(plan);

        if (options.sources !== undefined) {
          return options.sources.start(plan, slot, held);
        }

        if (options.throwOnStart === true) {
          throw failure;
        }

        const visit = options.visits?.[visitIndex];
        const selected = visitIndex === 0 ? firstDocument : secondDocument;
        visitIndex += 1;

        const closed = async (): Promise<Closed> => {
          const result = await (visit?.closed ?? Promise.resolve({ exited: true }));

          stage("closed");

          return result;
        };

        return { closed: closed(), document: visit?.document ?? Promise.resolve(selected) };
      },
    },
  });

  return { events, failure, fontLocales, owner, plans, scrapes };
};

const relevantEvents = (events: readonly string[]) =>
  events.filter((event) => !event.startsWith("binary:"));

describe("proxy and identity integration", () => {
  it.each([
    { clientProxy: undefined, methodProxy: undefined, username: /^configured-\d{8}$/u },
    {
      clientProxy: "http://client:secret@proxy.test",
      methodProxy: undefined,
      username: /^client$/u,
    },
    {
      clientProxy: "http://client:secret@proxy.test",
      methodProxy: "http://method:secret@proxy.test",
      username: /^method$/u,
    },
  ])(
    "selects a whole route for $clientProxy / $methodProxy",
    async ({ clientProxy, methodProxy, username }) => {
      const config: Pick<ResolvedConfig, "proxy"> = {
        proxy: { url: "http://configured-{session}:secret@proxy.test" },
      };

      const before = structuredClone(config);

      const { plans, scrapes } = harness({
        config,
        proxyInfo: () => {
          throw new Error("HTTP scrapes must not call geolocation.");
        },
      });

      using deadline = startDeadline(1000);

      const request = resolveScrapeIntent(
        { format: "html", proxy: methodProxy, url: "https://example.com" },
        resolveClientOptions({ mode: "http", proxy: clientProxy }),
      );

      try {
        await scrapes.start(request, deadline).answer;
        expect(plans[0].proxy?.credentials?.username).toMatch(username);
        expect(config).toStrictEqual(before);
      } finally {
        await scrapes.close();
      }
    },
  );

  it.each([
    { inferred: "de-DE", selected: "de-DE" },
    { inferred: "ar-JO", selected: "en-US" },
  ])("selects $selected before fonts for an inferred $inferred", async ({ inferred, selected }) => {
    const { fontLocales, plans, scrapes } = harness({
      proxyInfo: async () => await Promise.resolve({ ...proxyObservation, locale: inferred }),
    });

    using deadline = startDeadline(1000);

    try {
      await scrapes.start({ ...browserIntent, route: parseProxy("http://proxy.test") }, deadline)
        .answer;
      const [plan] = plans;

      if (plan.kind !== "browser") {
        throw new Error("Expected a browser plan.");
      }

      expect(fontLocales).toStrictEqual([selected]);
      expect(plan.identity.chosen.surfaces).toMatchObject({
        locale: { tag: selected },
        timezone: { source: "exit", zone: "Europe/Berlin" },
      });
      expect(plan.identity.chosen.exit).toMatchObject({
        facts: {
          address: proxyObservation.exitIp,
          destination: proxyObservation.destination,
          generation: 0,
          kind: "observed",
          observedAt: proxyObservation.observedAt,
          provider: proxyObservation.provider,
        },
        route: "proxy",
      });
      expect(JSON.stringify(plan.identity.chosen)).not.toContain("secret");
    } finally {
      await scrapes.close();
    }
  });

  it("keeps direct browser defaults and never looks up an exit", async () => {
    const { fontLocales, plans, scrapes } = harness({
      proxyInfo: () => {
        throw new Error("Direct routes must not call geolocation.");
      },
    });

    using deadline = startDeadline(1000);

    try {
      await scrapes.start(browserIntent, deadline).answer;
      const [plan] = plans;

      if (plan.kind !== "browser") {
        throw new Error("Expected a browser plan.");
      }

      expect(fontLocales).toStrictEqual(["en-US"]);
      expect(plan.identity.chosen.surfaces.timezone.source).toBe("host");
      expect(plan.identity.chosen.exit).toStrictEqual({
        facts: { kind: "unknown" },
        route: "direct",
      });
    } finally {
      await scrapes.close();
    }
  });

  it.each(["PROXY_AUTH_FAILED", "PROXY_UNREACHABLE", "PROXY_INFO_UNAVAILABLE"] as const)(
    "fails before host probes and browser launch on %s, without retrying",
    async (code) => {
      const failure = new XrioError(code, "Proxy lookup failed.", { details: undefined });
      let lookups = 0;

      const { events, plans, scrapes } = harness({
        proxyInfo: () => {
          lookups += 1;

          throw failure;
        },
      });

      using deadline = startDeadline(1000);

      const run = scrapes.start(
        { ...browserIntent, route: parseProxy("http://proxy.test") },
        deadline,
      );

      await expect(run.answer).rejects.toBe(failure);
      await scrapes.close();
      expect({ lookups, plans, probes: events.filter((event) => event === "host") }).toStrictEqual({
        lookups: 1,
        plans: [],
        probes: [],
      });
      expect(events).toContain("slot-release");
      expect(events).toContain("hold-release");
    },
  );

  it("keeps concurrent observations attached to the selected endpoint", async () => {
    const first = Promise.withResolvers<ProxyObservation>();
    const second = Promise.withResolvers<ProxyObservation>();
    const lookedUp: (string | ProxyEndpoint)[] = [];

    const { plans, scrapes } = harness({
      proxyInfo: async (endpoint) => {
        lookedUp.push(endpoint);

        return await (lookedUp.length === 1 ? first.promise : second.promise);
      },
    });

    using deadline = startDeadline(1000);

    const a = scrapes.start(
      { ...browserIntent, route: parseProxy("http://a:secret@proxy.test") },
      deadline,
    );

    const b = scrapes.start(
      { ...browserIntent, route: parseProxy("http://b:secret@proxy.test") },
      deadline,
    );

    second.resolve({ ...proxyObservation, locale: "fr-FR" });
    await b.answer;
    first.resolve(proxyObservation);
    await a.answer;
    await scrapes.close();

    expect(
      plans.map((plan) => [
        plan.proxy?.credentials?.username,
        plan.kind === "browser" ? plan.identity.chosen.surfaces.locale.tag : null,
      ]),
    ).toStrictEqual([
      ["b", "fr-FR"],
      ["a", "de-DE"],
    ]);
    expect(plans[0].proxy).toBe(lookedUp[1]);
    expect(plans[1].proxy).toBe(lookedUp[0]);
  });

  it("sends en-US through the HTTP relay without a lookup and keeps the configured session after a block", async () => {
    const headers: (string | undefined)[] = [];

    await using origin = await startFixtureServer((request, response) => {
      headers.push(request.headers["accept-language"]);
      response
        .writeHead(403, { "cf-mitigated": "challenge", "content-type": "text/html" })
        .end("<p>Blocked</p>");
    });

    await using proxy = await startFakeHttpProxy({ tunnelTo: Number(new URL(origin.origin).port) });

    const { plans, scrapes } = harness({
      config: { proxy: { url: proxy.url.replace("://", "://user-{session}:secret@") } },
      proxyInfo: () => {
        throw new Error("HTTP scrapes must not call geolocation.");
      },
      sources: {
        close: async () => {
          await Promise.resolve();
        },
        start: (plan, _slot, deadline) => {
          if (plan.kind !== "http") {
            throw new Error("Expected an HTTP plan.");
          }

          const document = loadHttpDocument(plan, deadline);

          return { closed: document.then(() => ({ exited: true })), document };
        },
      },
    });

    using deadline = startDeadline(10_000);

    try {
      const request = { ...intent, url: new URL("http://origin.test/") };
      const first = await scrapes.start(request, deadline).answer;
      const second = await scrapes.start(request, deadline).answer;

      expect({
        identity: first.identity,
        verdicts: [first.block.verdict, second.block.verdict],
      }).toMatchObject({
        identity: { locale: "en-US", mode: "http" },
        verdicts: ["blocked", "blocked"],
      });
      expect(JSON.stringify(first.identity)).not.toMatch(/secret|xrio:|127\.0\.0\.1/u);
      expect(headers).toStrictEqual(Array.from({ length: 2 }, () => "en-US,en;q=0.9"));
      const endpoint = plans[0].proxy;
      expect({
        requests: proxy.requests.length,
        sameRoute: plans[1].proxy === plans[0].proxy,
      }).toStrictEqual({ requests: 2, sameRoute: true });
      expect(proxy.requests.map(({ authorization }) => authorization)).toStrictEqual(
        Array.from(
          { length: 2 },
          () => `Basic ${btoa(`${endpoint?.credentials?.username}:secret`)}`,
        ),
      );
    } finally {
      await scrapes.close();
    }
  });
});

describe(createScrapes, () => {
  it.each(["document", "timeout"] as const)(
    "rejects queued browser work while the running visit finishes with its own %s outcome",
    async (outcome) => {
      const admission = createAdmission(1);
      const queued = Promise.withResolvers<null>();
      const captured = Promise.withResolvers<SourceDocument>();
      const retired = Promise.withResolvers<Closed>();
      const { advance, clock } = manualClock();
      using deadline = startDeadline(1000, undefined, clock);
      using waitingDeadline = startDeadline(2000, undefined, clock);
      let admissions = 0;

      const { events, scrapes } = harness({
        admission: {
          close: admission.close,
          slotFor: async (source, held) => {
            const offered = admission.slotFor(source, held);

            admissions += 1;

            if (admissions === 2) {
              queued.resolve(null);
            }

            return await offered;
          },
        },
        visits: [
          {
            closed: retired.promise,
            document: untilDeadline(async () => await captured.promise, deadline),
          },
        ],
      });

      const running = scrapes.start(browserIntent, deadline);
      const waiting = scrapes.start(browserIntent, waitingDeadline);
      const runningOutcome = outcomeOf(running.answer, deadline);

      const expectedOutcome =
        outcome === "document"
          ? { document: { html: "<p>First</p>" }, kind: "document" }
          : { error: { code: "TIMEOUT" }, kind: "failed" };

      await queued.promise;
      const closing = scrapes.close();
      const repeatedClosing = scrapes.close();

      await expect(waiting.answer).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
      await waiting.settled;
      expect(deadline.signal.aborted).toBeFalsy();

      if (outcome === "document") {
        captured.resolve(firstDocument);
      } else {
        advance(1000);
      }

      await expect(runningOutcome).resolves.toMatchObject(expectedOutcome);
      expect({
        sourcesClosed: events.includes("sources-close"),
        starts: events.filter((event) => event === "start"),
      }).toStrictEqual({ sourcesClosed: false, starts: ["start"] });
      retired.resolve({ exited: true });
      await Promise.all([closing, repeatedClosing, running.settled]);
      expect({
        closes: events.filter((event) => event === "sources-close"),
        finalEvents: events.slice(-2),
      }).toStrictEqual({
        closes: ["sources-close"],
        finalEvents: ["hold-release", "sources-close"],
      });
    },
  );

  it("keeps the first document without launching a revisit after close", async () => {
    const retired = Promise.withResolvers<Closed>();

    const { events, scrapes } = harness({
      admission: createAdmission(1),
      revisit: true,
      visits: [{ closed: retired.promise, document: Promise.resolve(firstDocument) }],
    });

    using deadline = startDeadline(1000);
    const run = scrapes.start(browserIntent, deadline);

    await expect.poll(() => events.includes("revisit-decision")).toBeTruthy();
    const closing = scrapes.close();

    retired.resolve({ exited: true });
    await expect(run.answer).resolves.toBe(firstDocument);
    await closing;
    expect(events.filter((event) => event === "start")).toStrictEqual(["start"]);
    expect(events.slice(-2)).toStrictEqual(["hold-release", "sources-close"]);
  });

  it("answers while the runtime is open and releases the slot before finishing the hold", async () => {
    const closing = Promise.withResolvers<Closed>();

    const { events, scrapes } = harness({
      visits: [{ closed: closing.promise, document: Promise.resolve(firstDocument) }],
    });

    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await expect(run.answer).resolves.toBe(firstDocument);
    events.push("answer");
    expect(relevantEvents(events)).toStrictEqual([
      "hold",
      "queue",
      "host",
      "start",
      "revisit-decision",
      "answer",
    ]);
    closing.resolve({ exited: true });
    await run.settled;
    expect(relevantEvents(events)).toStrictEqual([
      "hold",
      "queue",
      "host",
      "start",
      "revisit-decision",
      "answer",
      "closed",
      "slot-release",
      "finish",
      "hold-release",
    ]);
  });

  it.each([false, true])(
    "retains a document when the deadline expires during cleanup with revisit %s",
    async (revisit) => {
      const { advance, clock } = manualClock();
      const closed = Promise.withResolvers<Closed>();

      const { events, plans, scrapes } = harness({
        revisit,
        visits: [{ closed: closed.promise, document: Promise.resolve(firstDocument) }],
      });

      using deadline = startDeadline(1000, undefined, clock);
      const run = scrapes.start(intent, deadline);

      await expect.poll(() => events.includes("revisit-decision")).toBeTruthy();

      advance(1000);

      try {
        await expect.poll(async () => await run.answer, { timeout: 100 }).toBe(firstDocument);
        expect(events).not.toContain("hold-release");
      } finally {
        closed.resolve({ exited: true });
        await run.settled;
        await scrapes.close();
      }

      expect(plans).toHaveLength(1);
    },
  );

  it("stores the revisit decision before finish changes warmth and makes the second visit terminal", async () => {
    const { events, scrapes } = harness({ revisit: true });
    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await expect(run.answer).resolves.toBe(secondDocument);
    await run.settled;
    expect(events.filter((event) => event === "start")).toHaveLength(2);
    expect(events.filter((event) => event === "revisit-decision")).toHaveLength(1);
    expect(events.filter((event) => event === "finish")).toHaveLength(2);
    expect(events.indexOf("revisit-decision")).toBeLessThan(events.indexOf("finish"));
  });

  it("serves the kept first document when a revisit fails", async () => {
    const failure = new Error("The second source failed.");
    const failed = Promise.reject<SourceDocument>(failure);

    void Promise.allSettled([failed]);

    const { scrapes } = harness({
      revisit: true,
      visits: [
        { closed: Promise.resolve({ exited: true }), document: Promise.resolve(firstDocument) },
        { closed: Promise.resolve({ exited: true }), document: failed },
      ],
    });

    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await expect(run.answer).resolves.toBe(firstDocument);
    await expect(run.settled).resolves.toBeUndefined();
  });

  it.each([
    { expected: ["hold"], failureAt: "hold" },
    { expected: ["hold", "queue", "hold-release"], failureAt: "queue" },
    { expected: ["hold", "queue", "host", "slot-release", "hold-release"], failureAt: "host" },
  ])("releases everything acquired before $failureAt fails", async ({ expected, failureAt }) => {
    const { events, failure, scrapes } = harness({ failureAt });
    using deadline = startDeadline(1000);
    const run = scrapes.start(browserIntent, deadline);

    await expect(run.answer).rejects.toBe(failure);
    await expect(run.settled).resolves.toBeUndefined();
    expect(relevantEvents(events)).toStrictEqual(expected);
  });

  it("releases the slot and the hold when planning fails before the source starts", async () => {
    const { events, failure, scrapes } = harness({ failureAt: "plan" });
    using deadline = startDeadline(1000);
    const run = scrapes.start(browserIntent, deadline);

    await expect(run.answer).rejects.toBe(failure);
    await run.settled;
    expect(relevantEvents(events)).toStrictEqual([
      "hold",
      "queue",
      "host",
      "plan",
      "slot-release",
      "hold-release",
    ]);
  });

  it("releases the slot before the hold when the source throws on start", async () => {
    const { events, failure, scrapes } = harness({ throwOnStart: true });
    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await expect(run.answer).rejects.toBe(failure);
    await expect(run.settled).resolves.toBeUndefined();
    expect(events.slice(-3)).toStrictEqual(["start", "slot-release", "hold-release"]);
    expect(events).not.toContain("finish");
  });

  it("still releases the hold when the slot's release fails", async () => {
    const { events, scrapes } = harness({ cleanupFailure: "slot-release" });
    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await expect(run.answer).resolves.toBe(firstDocument);
    await expect(run.settled).resolves.toBeUndefined();
    expect(events.slice(-2)).toStrictEqual(["slot-release", "hold-release"]);
  });

  it("drains accepted work before closing sources and rejects new work", async () => {
    const closing = Promise.withResolvers<Closed>();

    const { events, scrapes } = harness({
      visits: [{ closed: closing.promise, document: Promise.resolve(firstDocument) }],
    });

    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await run.answer;
    const draining = scrapes.close();

    expect(() => scrapes.start(intent, deadline)).toThrow(
      expect.objectContaining({ code: "CLIENT_CLOSED" }),
    );
    expect(events).not.toContain("sources-close");
    closing.resolve({ exited: true });
    await draining;
    expect(events.slice(-2)).toStrictEqual(["hold-release", "sources-close"]);
  });

  it("compares an http scrape against the client's comparison binary", async () => {
    const { events, scrapes } = harness();
    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await run.answer;
    await run.settled;
    expect(events).toContain("binary:/comparison");
  });

  it("waits for closure after the first source rejection before releasing admission", async () => {
    const failure = new Error("The first source failed.");
    const rejected = Promise.reject<SourceDocument>(failure);

    void Promise.allSettled([rejected]);
    const closing = Promise.withResolvers<Closed>();

    const { events, scrapes } = harness({
      visits: [{ closed: closing.promise, document: rejected }],
    });

    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await expect(run.answer).rejects.toBe(failure);
    expect(events).not.toContain("slot-release");
    closing.resolve({ exited: true });
    await run.settled;
    expect(events.slice(-3)).toStrictEqual(["slot-release", "finish", "hold-release"]);
  });
});

describe("errors at the answer boundary", () => {
  it("answers SESSION_UNAVAILABLE when the hold's ownership ends a running visit", async () => {
    const stopped = Promise.withResolvers<SourceDocument>();

    void Promise.allSettled([stopped.promise]);

    const { owner, scrapes } = harness({
      visits: [{ closed: Promise.resolve({ exited: true }), document: stopped.promise }],
    });

    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);
    const reason = new Error("Ownership lost.");

    owner.signal.addEventListener("abort", () => {
      stopped.reject(owner.signal.reason);
    });
    owner.abort(reason);

    await expect(run.answer).rejects.toMatchObject({
      cause: reason,
      code: "SESSION_UNAVAILABLE",
      details: { reason: "ownership-lost" },
    });
    await run.settled;
  });

  it("keeps a classified error raised before the hold is released", async () => {
    const { failure, scrapes } = harness({ throwOnStart: true });
    using deadline = startDeadline(1000);
    const run = scrapes.start(intent, deadline);

    await expect(run.answer).rejects.toBe(failure);
    await run.settled;
  });
});

describe(createAnswer, () => {
  it("settles once and retains its first terminal document", async () => {
    const answer = createAnswer();

    answer.offer({ document: firstDocument, kind: "document" }, true);
    answer.offer({ document: secondDocument, kind: "document" }, true);
    answer.fail(new Error("A late failure."));
    answer.settleWithFallback();
    await expect(answer.promise).resolves.toBe(firstDocument);
  });

  it("settles the fallback in finally, including after a later planning failure", async () => {
    const answer = createAnswer();

    answer.offer({ document: firstDocument, kind: "document" }, false);
    answer.fail(new Error("Revisit planning failed."));
    answer.settleWithFallback();
    await expect(answer.promise).resolves.toBe(firstDocument);
  });

  it("rejects an unanswered run without a fallback", async () => {
    const answer = createAnswer();

    answer.settleWithFallback();
    await expect(answer.promise).rejects.toThrow("The scrape ended without a document.");
  });
});
