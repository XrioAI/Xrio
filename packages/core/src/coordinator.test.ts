import { describe, expect, it } from "vite-plus/test";

import { createAdmission } from "./admission.ts";
import type { Admission } from "./admission.ts";
import { createAnswer } from "./answer.ts";
import { classifyResponse } from "./blocks/classify.ts";
import { createScrapes } from "./coordinator.ts";
import { startDeadline, untilDeadline } from "./deadline.ts";
import { XrioError } from "./errors.ts";
import { httpIdentity } from "./humanizer/humanizer.ts";
import { HeldDeadline } from "./lifetime.ts";
import { resolveClientOptions, resolveScrapeIntent } from "./options.ts";
import { outcomeOf } from "./outcome.ts";
import { Slot } from "./slot.ts";
import type { Closed } from "./sources/browser/chrome-scope.ts";
import type { Visit } from "./sources/visit.ts";
import { fixedRandom } from "./testing/fixed-seed.ts";
import { manualClock } from "./testing/manual-clock.ts";
import { noPins } from "./testing/no-pins.ts";
import type { SourceDocument } from "./types.ts";

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
    ...response,
    block: classifyResponse({ html, requestUrls: [response.url], response }),
    html,
    identity: httpIdentity(noPins).report({ platform: "linux" }),
    requestUrls: [response.url],
  };
};

const firstDocument = documentFor("<p>First</p>");

const secondDocument = documentFor("<p>Second</p>");

interface HarnessOptions {
  readonly admission?: Admission;
  readonly visits?: readonly Visit[];
  readonly failureAt?: string;
  readonly revisit?: boolean;
  readonly cleanupFailure?: string;
  readonly throwOnStart?: boolean;
}

const harness = (options: HarnessOptions = {}) => {
  const events: string[] = [];
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
    fonts: {
      claim: async () => {
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

        return await Promise.resolve({ platform: "linux" });
      },
    },
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
        await Promise.resolve();
      },
      start: () => {
        stage("start");

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

  return { events, failure, owner, scrapes };
};

const relevantEvents = (events: readonly string[]) =>
  events.filter((event) => !event.startsWith("binary:"));

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
