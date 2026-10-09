import { once } from "node:events";
import { connect } from "node:net";

import { describe, expect, it, vi } from "vite-plus/test";

import { createAdmission } from "./admission.ts";
import type { Admission } from "./admission.ts";
import { createAnswer } from "./answer.ts";
import { classifyResponse } from "./blocks/classify.ts";
import type { ResolvedConfig } from "./config.ts";
import { createScrapes } from "./coordinator.ts";
import { startDeadline, untilDeadline } from "./deadline.ts";
import { XrioError } from "./errors.ts";
import type { HostCapabilities, PresentedUserAgent } from "./humanizer/contracts.ts";
import { httpIdentity } from "./humanizer/humanizer.ts";
import { canonicalZone } from "./humanizer/zone-name.ts";
import type { ScrapeIntent } from "./intent.ts";
import { HeldDeadline } from "./lifetime.ts";
import { parseProxy, resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { outcomeOf } from "./outcome.ts";
import type { ProxyObservation } from "./proxy/info.ts";
import type { Relay } from "./proxy/relay.ts";
import type { SessionHold } from "./sessions/session.ts";
import type { SessionBinding } from "./sessions/store.ts";
import { Slot } from "./slot.ts";
import type { Closed } from "./sources/browser/chrome-scope.ts";
import { createHttpConnections } from "./sources/http-connections.ts";
import { loadHttpDocument } from "./sources/http.ts";
import type { AttemptLog, FinishedVisit, Sources, Visit, VisitPlan } from "./sources/visit.ts";
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

const documentFor = (
  html: string,
  headers: Record<string, string> = {},
  status = 200,
): SourceDocument => {
  const response = { cookies: [], headers, status, url: "https://example.com" };

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

type StubVisit = Pick<Visit, "closed" | "document">;

interface StubSources {
  readonly close: Sources["close"];
  readonly start: (...visit: Parameters<Sources["start"]>) => StubVisit;
}

const challengeHeaders = { "cf-mitigated": "challenge", "content-type": "text/html" };

const blockedDocument = documentFor("<p>Blocked</p>", challengeHeaders, 403);

const blockedAgain = documentFor("<p>Blocked again</p>", challengeHeaders, 403);

interface HarnessOptions {
  readonly bindings?: readonly SessionBinding[];
  readonly config?: Pick<ResolvedConfig, "proxy">;
  readonly retryRandom?: () => number;
  readonly proxyInfo?: Parameters<typeof createScrapes>[0]["proxyInfo"];
  readonly sources?: StubSources;
  readonly admission?: Admission;
  readonly visits?: readonly StubVisit[];
  readonly failureAt?: string;
  readonly revisit?: boolean;
  readonly cleanupFailure?: string;
  readonly throwOnStart?: boolean;
  readonly claimWaits?: boolean;
  readonly releaseHold?: () => void;
  readonly random?: (size: number) => Uint8Array;
  readonly device?: SessionHold["device"];
  readonly headlessUserAgent?: PresentedUserAgent;
}

const harness = (options: HarnessOptions = {}) => {
  const events: string[] = [];
  const plans: VisitPlan[] = [];
  const finished: FinishedVisit[] = [];
  const attempts: AttemptLog[] = [];
  const fontLocales: string[] = [];
  const failure = new XrioError("NETWORK_ERROR", "The fake stage failed.", { details: undefined });
  const owner = new AbortController();
  let visitIndex = 0;
  let holdIndex = 0;
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
      chromeMajorFor: async () => await Promise.resolve(154),
      snapshotFor: async (binary, _deadline, mode) => {
        stage("host");
        events.push(`binary:${binary ?? "none"}`);

        const capabilities: HostCapabilities = { permittedCpus: 32, platform: "linux" };
        const { headlessUserAgent } = options;

        if (mode === "headless" && headlessUserAgent !== undefined) {
          return await Promise.resolve({ ...capabilities, headlessUserAgent });
        }

        return await Promise.resolve(capabilities);
      },
    },
    proxyInfo: options.proxyInfo,
    random: options.random ?? fixedRandom,
    retryRandom: options.retryRandom ?? (() => 0),
    sessions: {
      hold: async (_intent, checks, claim) => {
        stage("hold");
        const binding = options.bindings?.[holdIndex];
        holdIndex += 1;

        if (options.claimWaits === true) {
          await untilDeadline(async () => await Promise.withResolvers<never>().promise, claim);
        }

        return await Promise.resolve({
          [Symbol.asyncDispose]: async () => {
            stage("hold-release");
            options.releaseHold?.();
            await Promise.resolve();
          },
          bind: (deadline) => new HeldDeadline(deadline, owner.signal),
          binding,
          browserArgs: undefined,
          device: options.device ?? { kind: "fresh", seed: checks.seed() },
          drawStickyId: () => checks.stickyId?.() ?? "drawn",
          finish: async (visit) => {
            stage("finish");
            finished.push(visit);
            warmth = false;
            await Promise.resolve();
          },
          logAttempt: async (attempt) => {
            attempts.push(attempt);
            await Promise.resolve();
          },
          profile: { kind: "scratch" },
          retire: async () => {
            stage("retire");
            await Promise.resolve();
          },
          revisitWanted: () => {
            stage("revisit-decision");

            return warmth;
          },
          // oxlint-disable-next-line unicorn/no-useless-undefined -- The fake hold belongs to no session to summarize.
          summary: () => undefined,
        });
      },
    },
    sources: {
      close: async () => {
        stage("sources-close");
        await options.sources?.close();
        await Promise.resolve();
      },
      start: (plan, slot, held, relay) => {
        stage("start");
        plans.push(plan);

        if (options.sources !== undefined) {
          return { argv: Promise.resolve(null), ...options.sources.start(plan, slot, held, relay) };
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

        return {
          argv: Promise.resolve(["--fake-argv", plan.url.href]),
          closed: closed(),
          document: visit?.document ?? Promise.resolve(selected),
        };
      },
    },
  });

  return { attempts, events, failure, finished, fontLocales, owner, plans, scrapes };
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
    const connections = createHttpConnections();

    const { plans, scrapes } = harness({
      config: { proxy: { url: proxy.url.replace("://", "://user-{session}:secret@") } },
      proxyInfo: () => {
        throw new Error("HTTP scrapes must not call geolocation.");
      },
      sources: {
        close: connections.close,
        start: (plan, _slot, deadline) => {
          if (plan.kind !== "http") {
            throw new Error("Expected an HTTP plan.");
          }

          const document = loadHttpDocument(plan, deadline, connections);

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

  it("rejects a scrape still waiting for its session claim with CLIENT_CLOSED on close", async () => {
    const { clock } = manualClock();
    using deadline = startDeadline(60_000, undefined, clock);
    const { events, scrapes } = harness({ claimWaits: true });

    const waiting = scrapes.start(
      { ...browserIntent, session: { kind: "named", name: "account" } },
      deadline,
    );

    await expect.poll(() => events.includes("hold")).toBeTruthy();
    const closing = scrapes.close();

    await expect(waiting.answer).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await closing;
    expect(relevantEvents(events)).toStrictEqual([
      "host",
      "hold",
      "admission-close",
      "sources-close",
    ]);
  });

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

const failedVisit = (
  failure: Error,
  closed: Promise<Closed> = Promise.resolve({ exited: true }),
): StubVisit => {
  const document = Promise.reject<SourceDocument>(failure);
  void Promise.allSettled([document]);

  return { closed, document };
};

describe("transport retries", () => {
  it("keeps a retryable failure private until closure and finish, then reuses the frozen plan", async () => {
    const closed = Promise.withResolvers<Closed>();
    const failure = new XrioError("NETWORK_ERROR", "Connection failed.", { details: undefined });

    const { events, plans, scrapes } = harness({
      visits: [failedVisit(failure, closed.promise)],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 1 }, deadline);
    let answered = false;
    void run.answer.then(() => {
      answered = true;
    });

    await expect.poll(() => events.includes("start")).toBeTruthy();
    expect(answered).toBeFalsy();
    expect(events).not.toContain("finish");
    closed.resolve({ exited: true });
    await expect(run.answer).resolves.toBe(secondDocument);
    await run.settled;
    expect(plans[1]).toBe(plans[0]);
    expect(
      events.filter((event) => ["start", "closed", "slot-release", "finish"].includes(event)),
    ).toStrictEqual([
      "start",
      "closed",
      "slot-release",
      "finish",
      "start",
      "closed",
      "slot-release",
      "finish",
    ]);
  });

  it("preserves browser identity while reacquiring fonts and using the same held deadline", async () => {
    const deadlines: HeldDeadline[] = [];
    const failure = new XrioError("BROWSER_CRASHED", "Chrome exited.", { details: undefined });
    let starts = 0;

    const { fontLocales, plans, scrapes } = harness({
      sources: {
        close: async () => {
          await Promise.resolve();
        },
        start: (_plan, _slot, held) => {
          deadlines.push(held);
          starts += 1;

          return starts === 1
            ? failedVisit(failure)
            : {
                closed: Promise.resolve({ exited: true }),
                document: Promise.resolve(secondDocument),
              };
        },
      },
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...browserIntent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(secondDocument);
    await run.settled;
    expect(plans[1].identity).toBe(plans[0].identity);
    expect(deadlines[1]).toBe(deadlines[0]);
    expect(fontLocales).toStrictEqual(["en-US", "en-US"]);
  });

  it("retries a transport failure thrown during source start", async () => {
    const failure = new XrioError("PROXY_CONNECT_FAILED", "CONNECT failed.", {
      details: { status: 502 },
    });

    let starts = 0;

    const { events, scrapes } = harness({
      sources: {
        close: async () => {
          await Promise.resolve();
        },
        start: () => {
          starts += 1;

          if (starts === 1) {
            throw failure;
          }

          return {
            closed: Promise.resolve({ exited: true }),
            document: Promise.resolve(firstDocument),
          };
        },
      },
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(firstDocument);
    await run.settled;
    expect(starts).toBe(2);
    expect(events.filter((event) => event === "finish")).toHaveLength(1);
  });

  it.each([
    { expected: { code: "CLIENT_CLOSED" }, reason: "close" },
    { expected: { message: "Caller stopped." }, reason: "caller" },
  ])("stops backoff on %s without launching another attempt", async ({ reason, expected }) => {
    const { clock, pendingTimers } = manualClock();
    const caller = new AbortController();
    const failure = new XrioError("NETWORK_ERROR", "Connection failed.", { details: undefined });
    const { plans, scrapes } = harness({ retryRandom: () => 0.5, visits: [failedVisit(failure)] });
    using deadline = startDeadline(5000, caller.signal, clock);
    const run = scrapes.start({ ...intent, retries: 1 }, deadline);
    await expect.poll(pendingTimers).toBe(2);

    const cancelled = new Error("Caller stopped.");
    const closing = reason === "close" ? scrapes.close() : undefined;

    if (reason === "caller") {
      caller.abort(cancelled);
    }

    await expect(run.answer).rejects.toMatchObject(expected);
    await closing;
    await scrapes.close();

    expect(plans).toHaveLength(1);
    expect(pendingTimers()).toBe(1);
  });

  it.each([
    { expected: { code: "TIMEOUT" }, reason: "deadline" },
    { expected: { message: "Caller stopped." }, reason: "caller" },
    {
      expected: { code: "SESSION_UNAVAILABLE", details: { reason: "ownership-lost" } },
      reason: "ownership",
    },
  ])(
    "settles $reason during retry cleanup while retaining the slot and hold",
    async ({ expected, reason }) => {
      const { advance, clock } = manualClock();
      const closed = Promise.withResolvers<Closed>();
      const caller = new AbortController();
      const failure = new XrioError("NETWORK_ERROR", "Connection failed.", { details: undefined });

      const { events, owner, plans, scrapes } = harness({
        visits: [failedVisit(failure, closed.promise)],
      });

      using deadline = startDeadline(2000, caller.signal, clock);
      const run = scrapes.start({ ...intent, retries: 1 }, deadline);
      let settled = false;
      void run.settled.then(() => {
        settled = true;
      });

      const answer = outcomeOf(run.answer, deadline);
      const cancellation = new Error("Caller stopped.");
      await expect.poll(() => events.includes("start")).toBeTruthy();

      if (reason === "deadline") {
        advance(2000);
      } else if (reason === "caller") {
        caller.abort(cancellation);
      } else {
        owner.abort(cancellation);
      }

      try {
        await expect
          .poll(async () => await answer, { timeout: 100 })
          .toMatchObject({
            error: expected,
            kind: "failed",
          });
        let drained = false;

        const closing = scrapes.close().then(() => {
          drained = true;
        });

        await Promise.resolve();

        expect({
          attempts: plans.length,
          drained,
          holdReleased: events.includes("hold-release"),
          settled,
          slotReleased: events.includes("slot-release"),
          sourcesClosed: events.includes("sources-close"),
        }).toStrictEqual({
          attempts: 1,
          drained: false,
          holdReleased: false,
          settled: false,
          slotReleased: false,
          sourcesClosed: false,
        });
        closed.resolve({ exited: true });
        await run.settled;
        await closing;
        expect(plans).toHaveLength(1);
        expect(events.slice(-4)).toStrictEqual([
          "slot-release",
          "finish",
          "hold-release",
          "sources-close",
        ]);
      } finally {
        closed.resolve({ exited: true });
        await run.settled;
        await scrapes.close();
      }
    },
  );

  it("does not retry after closure consumes the minimum attempt budget", async () => {
    const { advance, clock } = manualClock();
    const closed = Promise.withResolvers<Closed>();
    const failure = new XrioError("NETWORK_ERROR", "Connection failed.", { details: undefined });
    const { events, plans, scrapes } = harness({ visits: [failedVisit(failure, closed.promise)] });
    using deadline = startDeadline(5000, undefined, clock);
    const run = scrapes.start({ ...intent, retries: 1 }, deadline);
    await expect.poll(() => events.includes("start")).toBeTruthy();
    advance(4500);
    closed.resolve({ exited: true });

    await expect(run.answer).rejects.toBe(failure);
    await run.settled;
    expect(plans).toHaveLength(1);
    await scrapes.close();
  });

  it("refuses retry after incomplete teardown", async () => {
    const failure = new XrioError("BROWSER_CRASHED", "Chrome exited.", { details: undefined });

    const { events, plans, scrapes } = harness({
      visits: [failedVisit(failure, Promise.resolve({ exited: false, reason: "Still running." }))],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...browserIntent, retries: 1 }, deadline);

    await expect(run.answer).rejects.toBe(failure);
    await run.settled;
    expect(plans).toHaveLength(1);
    expect(events).toContain("finish");
    await scrapes.close();
  });

  it("returns an HTTP error response without spending retries", async () => {
    const response = { ...firstDocument, status: 503 };

    const { plans, scrapes } = harness({
      visits: [{ closed: Promise.resolve({ exited: true }), document: Promise.resolve(response) }],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 3 }, deadline);

    await expect(run.answer).resolves.toBe(response);
    await run.settled;
    expect(plans).toHaveLength(1);
    await scrapes.close();
  });
});

describe("attempt log", () => {
  it.each([
    { failureAt: "queue", planned: false },
    { failureAt: "plan", planned: false },
    { failureAt: "start", planned: true },
  ])(
    "logs a start failure at $failureAt with its plan only once one exists",
    async ({ failureAt, planned }) => {
      const { attempts, finished, scrapes } = harness({ failureAt });
      using deadline = startDeadline(1000);
      const run = scrapes.start(browserIntent, deadline);

      await expect(run.answer).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      await run.settled;
      expect({
        attempts: attempts.map((attempt) => ({
          argv: attempt.argv,
          errorCode: attempt.errorCode,
          outcome: attempt.outcome,
          planned: /^[0-9a-f]{64}$/u.test(attempt.plan?.digest ?? ""),
          url: attempt.url,
        })),
        finished: finished.length,
      }).toStrictEqual({
        attempts: [
          {
            argv: null,
            errorCode: "NETWORK_ERROR",
            outcome: "failed",
            planned,
            url: "https://example.com/",
          },
        ],
        finished: 0,
      });
      await scrapes.close();
    },
  );

  it("logs a retried attempt and the attempt after it", async () => {
    const failure = new XrioError("NETWORK_ERROR", "Connection failed.", { details: undefined });
    const { finished, scrapes } = harness({ visits: [failedVisit(failure)] });
    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...browserIntent, retries: 1 }, deadline);

    await run.answer;
    await run.settled;
    expect(
      finished.map(({ errorCode, outcome, status }) => ({ errorCode, outcome, status })),
    ).toStrictEqual([
      { errorCode: "NETWORK_ERROR", outcome: "failed", status: null },
      { errorCode: null, outcome: "ok", status: 200 },
    ]);
    await scrapes.close();
  });

  it("finishes a launched visit with the argv its source reported and its plan", async () => {
    const { attempts, finished, scrapes } = harness();
    using deadline = startDeadline(1000);
    const run = scrapes.start(browserIntent, deadline);

    await run.answer;
    await run.settled;
    expect({
      attempts: attempts.length,
      finished: finished.map(({ argv, outcome, plan, site, status }) => ({
        argv,
        outcome,
        planned: /^[0-9a-f]{64}$/u.test(plan?.digest ?? ""),
        site,
        status,
      })),
    }).toStrictEqual({
      attempts: 0,
      finished: [
        {
          argv: ["--fake-argv", "https://example.com/"],
          outcome: "ok",
          planned: true,
          site: "example.com",
          status: 200,
        },
      ],
    });
    await scrapes.close();
  });
});

describe("session exit binding", () => {
  const binding = {
    kind: "proxy",
    region: { country: "US", zone: "America/New_York" },
    stickyId: "stored-id",
  } as const;

  const accepted = { ...proxyObservation, country: "US", timezone: "America/New_York" };

  const configured = {
    proxy: { session: {}, url: "http://account-{session}:secret@proxy.test" },
  } as const;

  it("accepts a different address and provider with the exact stored country and zone", async () => {
    const { plans, scrapes } = harness({
      bindings: [binding],
      config: configured,
      proxyInfo: async () =>
        await Promise.resolve({ ...accepted, exitIp: "203.0.113.9", provider: "ipwho.is" }),
    });

    using deadline = startDeadline(1000);

    try {
      await scrapes.start(
        { ...browserIntent, session: { kind: "named", name: "account" } },
        deadline,
      ).answer;
      expect(plans[0].proxy?.credentials?.username).toBe("account-stored-id");
      expect(plans[0].kind === "browser" && plans[0].sessionBinding).toStrictEqual(binding);
    } finally {
      await scrapes.close();
    }
  });

  it("rejects a different zone name after the stored id and three replacement ids", async () => {
    const users: (string | undefined)[] = [];

    const { plans, scrapes } = harness({
      bindings: [binding],
      config: configured,
      proxyInfo: async (proxy) => {
        users.push(proxy.credentials?.username);

        return await Promise.resolve({ ...accepted, timezone: "America/Detroit" });
      },
    });

    using deadline = startDeadline(1000);

    try {
      await expect(
        scrapes.start({ ...browserIntent, session: { kind: "named", name: "account" } }, deadline)
          .answer,
      ).rejects.toMatchObject({ code: "SESSION_UNAVAILABLE", details: { reason: "exit-changed" } });
      expect(users).toHaveLength(4);
      expect(users[0]).toBe("account-stored-id");
      expect(users.slice(1)).toStrictEqual([
        expect.stringMatching(/^account-\d{8}$/u),
        expect.stringMatching(/^account-\d{8}$/u),
        expect.stringMatching(/^account-\d{8}$/u),
      ]);
      expect(plans).toStrictEqual([]);
    } finally {
      await scrapes.close();
    }
  });

  it("plans the first matching replacement id without retrying the document", async () => {
    const users: (string | undefined)[] = [];

    const { plans, scrapes } = harness({
      bindings: [binding],
      config: configured,
      proxyInfo: async (proxy) => {
        users.push(proxy.credentials?.username);

        return await Promise.resolve(
          users.length === 1 ? { ...accepted, country: "CA" } : accepted,
        );
      },
    });

    using deadline = startDeadline(1000);

    try {
      await scrapes.start(
        { ...browserIntent, session: { kind: "named", name: "account" } },
        deadline,
      ).answer;
      expect(users).toHaveLength(2);
      expect(plans).toHaveLength(1);
      expect(plans[0].proxy?.credentials?.username).toBe(users[1]);
      expect(plans[0].kind === "browser" && plans[0].sessionBinding).toMatchObject({
        kind: "proxy",
        region: { country: "US", zone: "America/New_York" },
      });
    } finally {
      await scrapes.close();
    }
  });

  it.each([
    {
      expected: "http://account-stored-id:secret@proxy.test/",
      route: undefined,
      routing: { bindings: [binding], config: configured },
    },
    {
      expected: "http://client:secret@proxy.test:8080/",
      route: parseProxy("http://client:secret@proxy.test:8080"),
      routing: { bindings: [binding], config: configured },
    },
    { expected: null, route: undefined, routing: {} },
  ])(
    "finishes a visit with the exact proxy URL $expected it used",
    async ({ expected, route, routing }) => {
      const { finished, scrapes } = harness({
        ...routing,
        proxyInfo: async () => await Promise.resolve(accepted),
      });

      using deadline = startDeadline(1000);

      try {
        const run = scrapes.start(
          { ...browserIntent, route, session: { kind: "named", name: "account" } },
          deadline,
        );

        await run.answer;
        await run.settled;
        expect(finished.map(({ proxyUrl }) => proxyUrl)).toStrictEqual([expected]);
      } finally {
        await scrapes.close();
      }
    },
  );

  it.each([
    { binding: { kind: "direct", stickyId: "direct" } as const, proxy: "http://proxy.test" },
    { binding, proxy: undefined },
  ])("refuses switching an established route kind", async ({ binding: stored, proxy }) => {
    const { plans, scrapes } = harness({ bindings: [stored] });
    using deadline = startDeadline(1000);

    try {
      await expect(
        scrapes.start(
          {
            ...browserIntent,
            route: proxy === undefined ? undefined : parseProxy(proxy),
            session: { kind: "named", name: "account" },
          },
          deadline,
        ).answer,
      ).rejects.toMatchObject({ code: "SESSION_UNAVAILABLE", details: { reason: "exit-changed" } });
      expect(plans).toStrictEqual([]);
    } finally {
      await scrapes.close();
    }
  });

  it("retires an exhausted pool member and visits a fresh member under the same deadline", async () => {
    let observations = 0;

    const { events, plans, scrapes } = harness({
      bindings: [binding, { kind: "unbound", stickyId: "fresh-id" }],
      config: configured,
      proxyInfo: async () => {
        observations += 1;

        return await Promise.resolve({ ...accepted, country: "CA" });
      },
    });

    using deadline = startDeadline(1000);

    try {
      await scrapes.start(
        {
          ...browserIntent,
          session: { kind: "pool", name: "accounts", site: "https://example.com", size: 2 },
        },
        deadline,
      ).answer;
      expect(observations).toBe(5);
      expect(events.filter((event) => event === "hold")).toStrictEqual(["hold", "hold"]);
      expect(events.filter((event) => event === "retire")).toStrictEqual(["retire"]);
      expect(plans).toHaveLength(1);
      expect(plans[0].proxy?.credentials?.username).toBe("account-fresh-id");
    } finally {
      await scrapes.close();
    }
  });

  it.each(["Asia/Calcutta", "Asia/Kolkata"])(
    "keeps a binding when the provider spells its zone %s",
    async (observed) => {
      let lookups = 0;

      const stored = {
        kind: "proxy",
        region: { country: "IN", zone: canonicalZone("Asia/Kolkata") ?? "" },
        stickyId: "stored-id",
      } as const;

      const { plans, scrapes } = harness({
        bindings: [stored],
        config: configured,
        proxyInfo: async () => {
          lookups += 1;

          return await Promise.resolve({ ...accepted, country: "IN", timezone: observed });
        },
      });

      using deadline = startDeadline(1000);

      try {
        await scrapes.start(
          { ...browserIntent, session: { kind: "named", name: "account" } },
          deadline,
        ).answer;
        expect({
          binding: plans[0].kind === "browser" && plans[0].sessionBinding,
          lookups,
        }).toStrictEqual({
          binding: stored,
          lookups: 1,
        });
      } finally {
        await scrapes.close();
      }
    },
  );

  it("fails a pool scrape with TIMEOUT when its deadline passes while a retired member is released", async () => {
    const time = manualClock();
    using deadline = startDeadline(1000, undefined, time.clock);

    const { events, plans, scrapes } = harness({
      bindings: [binding, { kind: "unbound", stickyId: "fresh-id" }],
      config: configured,
      proxyInfo: async () => await Promise.resolve({ ...accepted, country: "CA" }),
      releaseHold: () => {
        time.advance(1000);
      },
    });

    try {
      const run = scrapes.start(
        {
          ...browserIntent,
          session: { kind: "pool", name: "accounts", site: "example.com", size: 2 },
        },
        deadline,
      );

      await expect(run.answer).rejects.toMatchObject({ code: "TIMEOUT" });
      await expect(run.settled).resolves.toBeUndefined();
      expect({
        holds: events.filter((event) => event === "hold" || event === "retire"),
        plans,
      }).toStrictEqual({ holds: ["hold", "retire"], plans: [] });
    } finally {
      await scrapes.close();
    }
  });
});

const answered = (document: SourceDocument): StubVisit => ({
  closed: Promise.resolve({ exited: true }),
  document: Promise.resolve(document),
});

const managedProxy: Pick<ResolvedConfig, "proxy"> = {
  proxy: { url: "http://user-{session}:secret@proxy.test" },
};

const SESSION_USER = /^user-\d{8}$/u;

const usernamesOf = (plans: readonly VisitPlan[]) =>
  plans.map((plan) => plan.proxy?.credentials?.username);

const sessionFailure = () =>
  new XrioError("NETWORK_ERROR", "Connection failed.", { details: undefined });

const countingRandom = () => {
  let draws = 0;

  return (size: number) => {
    draws += 1;

    return new Uint8Array(size).fill(draws);
  };
};

const presentedDevicesOf = (plans: readonly VisitPlan[]) =>
  plans.map((plan) =>
    plan.kind === "browser"
      ? { record: plan.identity.chosen.record, seed: plan.identity.chosen.seed }
      : null,
  );

const observedExit = async () => await Promise.resolve(proxyObservation);

const stickyBinding = {
  kind: "proxy",
  region: { country: "DE", zone: "Europe/Berlin" },
  stickyId: "stored-id",
} as const;

const replayedRecord = {
  device: {
    cores: 0,
    fonts: { kind: "system" },
    gpu: { backend: "swiftshader", persona: null },
    memoryGb: 0,
    screen: { height: 1000, width: 1700, workArea: { bottom: 50, left: 0, right: 0, top: 0 } },
    voices: { kind: "system" },
    window: { height: 800, kind: "floating", width: 1300, x: 100, y: 60 },
  },
  policy: { locale: "en-US", timezone: { kind: "pinned", zone: "UTC" } },
  schema: 1,
  seed: "00000000000000a1",
} as const;

describe("fresh-exit retries", () => {
  it("retries a blocked page on a new proxy session and moves the client's shared exit", async () => {
    const { events, plans, scrapes } = harness({
      config: managedProxy,
      visits: [answered(blockedDocument)],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(secondDocument);
    await run.settled;
    await scrapes.start(intent, deadline).settled;
    await scrapes.close();

    const [blocked, fresh] = usernamesOf(plans);

    expect({
      attempts: run.attempts(),
      finishes: events.filter((event) => event === "finish").length,
      verdict: blockedDocument.block.verdict,
    }).toStrictEqual({ attempts: { freshExits: 1, total: 2 }, finishes: 3, verdict: "blocked" });
    expect(usernamesOf(plans)).toStrictEqual([expect.stringMatching(SESSION_USER), fresh, fresh]);
    expect(fresh).toMatch(SESSION_USER);
    expect(fresh).not.toBe(blocked);
  });

  it("plans the browser identity again for the fresh exit", async () => {
    const lookedUp: (string | ProxyEndpoint)[] = [];
    const observations = [proxyObservation, { ...proxyObservation, locale: "fr-FR" }];

    const { fontLocales, plans, scrapes } = harness({
      config: managedProxy,
      proxyInfo: async (endpoint) => {
        lookedUp.push(endpoint);

        return await Promise.resolve(observations[lookedUp.length - 1]);
      },
      visits: [answered(blockedDocument)],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...browserIntent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(secondDocument);
    await scrapes.close();

    expect(lookedUp).toStrictEqual(plans.map((plan) => plan.proxy));
    expect({
      exits: new Set(lookedUp).size,
      fontLocales,
      locales: plans.map((plan) =>
        plan.kind === "browser" ? plan.identity.chosen.surfaces.locale.tag : null,
      ),
    }).toStrictEqual({ exits: 2, fontLocales: ["de-DE", "fr-FR"], locales: ["de-DE", "fr-FR"] });
  });

  it.each([
    {
      config: { proxy: { url: "http://user:secret@proxy.test" } },
      route: undefined,
      title: "a configured proxy without {session}",
    },
    {
      config: managedProxy,
      route: parseProxy("http://client:secret@proxy.test"),
      title: "an explicit proxy",
    },
    { config: undefined, route: undefined, title: "a direct route" },
  ])("answers the blocked page from $title without retrying it", async ({ config, route }) => {
    const { plans, scrapes } = harness({ config, visits: [answered(blockedDocument)] });
    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 2, route }, deadline);

    await expect(run.answer).resolves.toBe(blockedDocument);
    await scrapes.close();

    expect({ attempts: run.attempts(), plans: plans.length }).toStrictEqual({
      attempts: { freshExits: 0, total: 1 },
      plans: 1,
    });
  });

  it.each([
    { elapsedMs: 0, reason: "no retries are configured", retries: 0 },
    { elapsedMs: 4500, reason: "less than a minimum attempt remains", retries: 1 },
  ])("keeps the blocked page and the shared exit when $reason", async ({ elapsedMs, retries }) => {
    const { advance, clock } = manualClock();
    const pending = Promise.withResolvers<SourceDocument>();

    const { events, plans, scrapes } = harness({
      config: managedProxy,
      visits: [{ closed: Promise.resolve({ exited: true }), document: pending.promise }],
    });

    using deadline = startDeadline(5000, undefined, clock);
    const run = scrapes.start({ ...intent, retries }, deadline);

    await expect.poll(() => events.includes("start")).toBeTruthy();
    advance(elapsedMs);
    pending.resolve(blockedDocument);

    await expect(run.answer).resolves.toBe(blockedDocument);
    await run.settled;
    using laterDeadline = startDeadline(1000);
    await scrapes.start(intent, laterDeadline).settled;
    await scrapes.close();

    expect(run.attempts()).toStrictEqual({ freshExits: 0, total: 1 });
    expect(plans).toHaveLength(2);
    expect(plans[1].proxy).toBe(plans[0].proxy);
  });

  it("answers the last blocked page once the retries are spent", async () => {
    const { plans, scrapes } = harness({
      config: managedProxy,
      visits: [answered(blockedDocument), answered(blockedAgain)],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(blockedAgain);
    await scrapes.close();

    expect(run.attempts()).toStrictEqual({ freshExits: 1, total: 2 });
    expect(new Set(usernamesOf(plans)).size).toBe(2);
  });

  it("shares the budget with transport retries, which keep the fresh exit's plan", async () => {
    const { plans, scrapes } = harness({
      config: managedProxy,
      visits: [answered(blockedDocument), failedVisit(sessionFailure())],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 2 }, deadline);

    await expect(run.answer).resolves.toBe(secondDocument);
    await scrapes.close();

    expect(run.attempts()).toStrictEqual({ freshExits: 1, total: 3 });
    expect(plans[2]).toBe(plans[1]);
    expect(plans[1].proxy).not.toBe(plans[0].proxy);
  });

  it("answers the blocked page when the fresh exit fails after the last retry", async () => {
    const { plans, scrapes } = harness({
      config: managedProxy,
      visits: [answered(blockedDocument), failedVisit(sessionFailure())],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(blockedDocument);
    await scrapes.close();

    expect({ attempts: run.attempts(), plans: plans.length }).toStrictEqual({
      attempts: { freshExits: 1, total: 2 },
      plans: 2,
    });
  });

  it("answers the blocked page when the fresh exit's lookup fails", async () => {
    const unavailable = new XrioError("PROXY_INFO_UNAVAILABLE", "Lookup failed.", {
      details: undefined,
    });

    let lookups = 0;

    const { plans, scrapes } = harness({
      config: managedProxy,
      proxyInfo: async () => {
        lookups += 1;

        if (lookups > 1) {
          throw unavailable;
        }

        return await Promise.resolve(proxyObservation);
      },
      visits: [answered(blockedDocument)],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...browserIntent, retries: 2 }, deadline);

    await expect(run.answer).resolves.toBe(blockedDocument);
    await scrapes.close();

    expect({ attempts: run.attempts(), lookups, plans: plans.length }).toStrictEqual({
      attempts: { freshExits: 1, total: 2 },
      lookups: 2,
      plans: 1,
    });
  });

  it("answers the blocked page without a fresh exit after incomplete teardown", async () => {
    const { plans, scrapes } = harness({
      config: managedProxy,
      visits: [
        {
          closed: Promise.resolve({ exited: false, reason: "Still running." }),
          document: Promise.resolve(blockedDocument),
        },
      ],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...intent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(blockedDocument);
    await scrapes.close();

    expect({ attempts: run.attempts(), plans: plans.length }).toStrictEqual({
      attempts: { freshExits: 0, total: 1 },
      plans: 1,
    });
  });

  it.each([
    {
      bindings: [stickyBinding],
      label: "a named session",
      session: { kind: "named", name: "account" },
      username: /^user-stored-id$/u,
    },
    {
      bindings: [stickyBinding],
      label: "a pool member",
      session: { kind: "pool", name: "accounts", site: "https://example.com", size: 2 },
      username: /^user-stored-id$/u,
    },
    {
      bindings: undefined,
      label: "a session hold without a binding",
      session: { kind: "named", name: "account" },
      username: SESSION_USER,
    },
  ] as const)(
    "answers the blocked page of $label without a fresh exit",
    async ({ bindings, session, username }) => {
      const { finished, plans, scrapes } = harness({
        bindings,
        config: managedProxy,
        proxyInfo: observedExit,
        random: countingRandom(),
        visits: [answered(blockedDocument)],
      });

      using deadline = startDeadline(5000);
      const run = scrapes.start({ ...browserIntent, retries: 2, session }, deadline);

      await expect(run.answer).resolves.toBe(blockedDocument);
      await run.settled;
      await scrapes.close();

      expect({
        attempts: run.attempts(),
        finished: finished.length,
        seeds: presentedDevicesOf(plans).map((device) => device?.seed),
        usernames: usernamesOf(plans),
      }).toStrictEqual({
        attempts: { freshExits: 0, total: 1 },
        finished: 1,
        seeds: ["0101010101010101"],
        usernames: [expect.stringMatching(username)],
      });
    },
  );

  it("presents a device drawn from a new seed behind the fresh exit", async () => {
    const { plans, scrapes } = harness({
      config: managedProxy,
      proxyInfo: observedExit,
      random: countingRandom(),
      visits: [answered(blockedDocument)],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...browserIntent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(secondDocument);
    await scrapes.close();

    expect(
      presentedDevicesOf(plans).map((device) => ({
        recordSeed: device?.record?.seed,
        seed: device?.seed,
      })),
    ).toStrictEqual([
      { recordSeed: "0101010101010101", seed: "0101010101010101" },
      { recordSeed: "0202020202020202", seed: "0202020202020202" },
    ]);
    expect(new Set(usernamesOf(plans)).size).toBe(2);
  });

  it("keeps a replayed device record behind the fresh exit", async () => {
    const { plans, scrapes } = harness({
      config: managedProxy,
      device: { kind: "record", record: replayedRecord },
      proxyInfo: observedExit,
      random: countingRandom(),
      visits: [answered(blockedDocument)],
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...browserIntent, retries: 1 }, deadline);

    await expect(run.answer).resolves.toBe(secondDocument);
    await scrapes.close();

    expect(presentedDevicesOf(plans)).toStrictEqual([
      { record: replayedRecord, seed: "00000000000000a1" },
      { record: replayedRecord, seed: "00000000000000a1" },
    ]);
    expect(new Set(usernamesOf(plans)).size).toBe(2);
  });
});

describe("headless stock Chrome's user agent", () => {
  const headedUserAgent: PresentedUserAgent = {
    metadata: {
      architecture: "x86",
      bitness: "64",
      brands: [{ brand: "Chromium", version: "154" }],
      formFactors: ["Desktop"],
      fullVersion: "154.0.8037.57",
      fullVersionList: [{ brand: "Chromium", version: "154.0.8037.57" }],
      mobile: false,
      model: "",
      platform: "Linux",
      platformVersion: "6.8.0",
      wow64: false,
    },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0 Safari/537.36",
  };

  const launchOf = async (mode: "headed" | "headless", session: ScrapeIntent["session"]) => {
    const { plans, scrapes } = harness({ headlessUserAgent: headedUserAgent });

    using deadline = startDeadline(1000);

    try {
      await scrapes.start(
        { ...browserIntent, session, source: { ...browserIntent.source, mode } },
        deadline,
      ).answer;
      const [plan] = plans;

      if (plan.kind !== "browser") {
        throw new Error("Expected a browser plan.");
      }

      const { switches, userAgent } = plan.identity.inputs;

      return { switches: switches.filter((name) => name.startsWith("--user-agent")), userAgent };
    } finally {
      await scrapes.close();
    }
  };

  it.each([
    { name: "anonymous", session: { kind: "anonymous" } },
    { name: "named", session: { kind: "named", name: "account" } },
    {
      name: "pooled",
      session: { kind: "pool", name: "accounts", site: "https://example.com", size: 2 },
    },
  ] as const)(
    "presents headed Chrome's user agent in a headless $name scrape",
    async ({ session }) => {
      await expect(launchOf("headless", session)).resolves.toStrictEqual({
        switches: ["--user-agent=Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0 Safari/537.36"],
        userAgent: headedUserAgent,
      });
    },
  );

  it("leaves a headed named session scrape's user agent to Chrome", async () => {
    await expect(launchOf("headed", { kind: "named", name: "account" })).resolves.toStrictEqual({
      switches: [],
      userAgent: undefined,
    });
  });
});

const connectReplyThrough = async (relay: Relay | undefined, authority: string) => {
  if (relay === undefined) {
    throw new Error("Expected the visit's proxy relay.");
  }

  const socket = connect({ host: "127.0.0.1", port: Number(new URL(relay.url).port) });

  try {
    await once(socket, "connect");
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const pieces: readonly unknown[] = await once(socket, "data");
    const [reply] = pieces;

    if (!Buffer.isBuffer(reply)) {
      throw new TypeError("The relay answered CONNECT with text instead of bytes.");
    }

    return reply.toString("latin1");
  } finally {
    socket.destroy();
  }
};

const tunnelsThrough = (username: string | undefined) =>
  ["origin.test:443", "other.test:443"].map((authority) => ({
    authority,
    authorization: `Basic ${btoa(`${username}:secret`)}`,
  }));

interface RelayedVisit {
  readonly connectsBefore: number;
  readonly document: SourceDocument;
}

const relayingSources = (
  proxy: { readonly requests: readonly unknown[] },
  replies: string[],
  visits: readonly RelayedVisit[],
): StubSources => {
  let started = 0;

  return {
    close: async () => {
      await Promise.resolve();
    },
    start: (_plan, _slot, _held, relay) => {
      const { connectsBefore, document: answer } = visits[started];

      started += 1;

      const visit = async () => {
        await vi.waitFor(() => {
          expect(proxy.requests).toHaveLength(connectsBefore);
        });
        replies.push(await connectReplyThrough(relay, "other.test:443"));

        return answer;
      };

      const document = visit();

      return { closed: document.then(() => ({ exited: true })), document };
    },
  };
};

describe("the browser visit's proxy relay", () => {
  const originIntent = {
    ...browserIntent,
    url: new URL("https://origin.test/"),
  };

  const ESTABLISHED = "HTTP/1.1 200 Connection Established\r\n\r\n";

  it("opens its tunnel to the target during the exit lookup, then hands it to the first CONNECT", async () => {
    await using origin = await startFixtureServer((_request, response) => {
      response.end();
    });

    await using proxy = await startFakeHttpProxy({ tunnelTo: Number(new URL(origin.origin).port) });
    const authorities = () => proxy.requests.map(({ authority }) => authority);
    const replies: string[] = [];

    const { scrapes } = harness({
      proxyInfo: async () => {
        await vi.waitFor(() => {
          expect([authorities(), proxy.answeredConnects]).toStrictEqual([["origin.test:443"], 1]);
        });

        return proxyObservation;
      },
      sources: {
        close: async () => {
          await Promise.resolve();
        },
        start: (_plan, _slot, _held, relay) => {
          const visit = async () => {
            replies.push(await connectReplyThrough(relay, "origin.test:443"));

            return firstDocument;
          };

          const document = visit();

          return { closed: document.then(() => ({ exited: true })), document };
        },
      },
    });

    using deadline = startDeadline(5000);

    try {
      await scrapes.start({ ...originIntent, route: parseProxy(proxy.url) }, deadline).answer;
    } finally {
      await scrapes.close();
    }

    expect([replies, authorities()]).toStrictEqual([[ESTABLISHED], ["origin.test:443"]]);
  });

  it("closes the tunnel it opened when planning fails", async () => {
    await using origin = await startFixtureServer((_request, response) => {
      response.end();
    });

    await using proxy = await startFakeHttpProxy({ tunnelTo: Number(new URL(origin.origin).port) });
    const failure = new XrioError("PROXY_INFO_UNAVAILABLE", "No exit.", { details: undefined });

    const { plans, scrapes } = harness({
      proxyInfo: async () => {
        await vi.waitFor(() => {
          expect(proxy.openConnections).toBe(1);
        });

        throw failure;
      },
    });

    using deadline = startDeadline(5000);

    try {
      await expect(
        scrapes.start({ ...originIntent, route: parseProxy(proxy.url) }, deadline).answer,
      ).rejects.toBe(failure);
    } finally {
      await scrapes.close();
    }

    await vi.waitFor(() => {
      expect(proxy.openConnections).toBe(0);
    });
    expect(plans).toStrictEqual([]);
  });

  it("forwards a managed session through its sticky id's proxy, opened during the exit lookup", async () => {
    await using origin = await startFixtureServer((_request, response) => {
      response.end();
    });

    await using proxy = await startFakeHttpProxy({ tunnelTo: Number(new URL(origin.origin).port) });
    const replies: string[] = [];

    const { plans, scrapes } = harness({
      bindings: [stickyBinding],
      config: { proxy: { url: proxy.url.replace("://", "://account-{session}:secret@") } },
      proxyInfo: async () => {
        await vi.waitFor(() => {
          expect(proxy.answeredConnects).toBe(1);
        });

        return proxyObservation;
      },
      sources: relayingSources(proxy, replies, [{ connectsBefore: 1, document: firstDocument }]),
    });

    using deadline = startDeadline(5000);

    try {
      await scrapes.start(
        { ...originIntent, session: { kind: "named", name: "account" } },
        deadline,
      ).answer;
    } finally {
      await scrapes.close();
    }

    expect({
      replies,
      requests: proxy.requests,
      users: usernamesOf(plans),
    }).toStrictEqual({
      replies: [ESTABLISHED],
      requests: tunnelsThrough("account-stored-id"),
      users: ["account-stored-id"],
    });
  });

  it("forwards through the sticky id drawn after the stored one left its region", async () => {
    await using origin = await startFixtureServer((_request, response) => {
      response.end();
    });

    await using proxy = await startFakeHttpProxy({ tunnelTo: Number(new URL(origin.origin).port) });
    const replies: string[] = [];
    let lookups = 0;

    const { plans, scrapes } = harness({
      bindings: [stickyBinding],
      config: { proxy: { url: proxy.url.replace("://", "://account-{session}:secret@") } },
      proxyInfo: async () => {
        lookups += 1;

        if (lookups > 1) {
          return proxyObservation;
        }

        await vi.waitFor(() => {
          expect(proxy.answeredConnects).toBe(1);
        });

        return { ...proxyObservation, country: "AT", timezone: "Europe/Vienna" };
      },
      sources: relayingSources(proxy, replies, [{ connectsBefore: 2, document: firstDocument }]),
    });

    using deadline = startDeadline(5000);

    try {
      await scrapes.start(
        { ...originIntent, session: { kind: "named", name: "account" } },
        deadline,
      ).answer;
    } finally {
      await scrapes.close();
    }

    const [drawn] = usernamesOf(plans);
    const [stored] = tunnelsThrough("account-stored-id");

    expect({ lookups, replies, requests: proxy.requests }).toStrictEqual({
      lookups: 2,
      replies: [ESTABLISHED],
      requests: [stored, ...tunnelsThrough(drawn)],
    });
    expect(drawn).toMatch(/^account-\d{8}$/u);
  });

  it("forwards a fresh-exit retry through the fresh exit", async () => {
    await using origin = await startFixtureServer((_request, response) => {
      response.end();
    });

    await using proxy = await startFakeHttpProxy({ tunnelTo: Number(new URL(origin.origin).port) });
    const replies: string[] = [];

    const { plans, scrapes } = harness({
      config: { proxy: { url: proxy.url.replace("://", "://user-{session}:secret@") } },
      proxyInfo: observedExit,
      sources: relayingSources(proxy, replies, [
        { connectsBefore: 1, document: blockedDocument },
        { connectsBefore: 3, document: firstDocument },
      ]),
    });

    using deadline = startDeadline(5000);
    const run = scrapes.start({ ...originIntent, retries: 1 }, deadline);

    try {
      await expect(run.answer).resolves.toBe(firstDocument);
    } finally {
      await scrapes.close();
    }

    const [blocked, fresh] = usernamesOf(plans);

    expect({
      attempts: run.attempts(),
      replies,
      requests: proxy.requests,
      users: [blocked, fresh],
    }).toStrictEqual({
      attempts: { freshExits: 1, total: 2 },
      replies: [ESTABLISHED, ESTABLISHED],
      requests: [...tunnelsThrough(blocked), ...tunnelsThrough(fresh)],
      users: [expect.stringMatching(SESSION_USER), expect.stringMatching(SESSION_USER)],
    });
    expect(fresh).not.toBe(blocked);
  });
});
