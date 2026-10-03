import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import { connectOverPipe } from "./connection.ts";
import type { ConnectionEvent } from "./connection.ts";
import { BROWSER } from "./protocol.ts";
import type { TargetSession } from "./protocol.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const CHROME_CHUNK_BYTES = 64 * 1024;

const OVER_THE_CAP_CHUNKS = 513;

const FILLER = Buffer.alloc(CHROME_CHUNK_BYTES, "a");

const GONE = "The browser or its renderer died.";

const MAIN: TargetSession<"main"> = { id: "S1", scope: "main", targetId: "T1" };

const pageAttached = (sessionId: string, targetId: string): Json => ({
  method: "Target.attachedToTarget",
  params: { sessionId, targetInfo: { targetId, type: "page" }, waitingForDebugger: false },
});

const childAttached = (parent: string, sessionId: string, type: string): Json => ({
  method: "Target.attachedToTarget",
  params: { sessionId, targetInfo: { targetId: `${type}-target`, type }, waitingForDebugger: true },
  sessionId: parent,
});

const framed = (messages: readonly Json[]): Buffer =>
  Buffer.from(messages.map((message) => `${JSON.stringify(message)}\0`).join(""));

const isInternalEvent = (message: unknown): message is { event: string; detail: string } =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  typeof message.event === "string" &&
  "detail" in message &&
  typeof message.detail === "string";

const isSentCommand = (message: unknown): message is { method: string; scope: string } =>
  typeof message === "object" &&
  message !== null &&
  "method" in message &&
  typeof message.method === "string" &&
  "scope" in message &&
  typeof message.scope === "string";

const recordChannel = <Message>(name: string, accept: (message: unknown) => message is Message) => {
  const messages: Message[] = [];

  const record: ChannelListener = (message) => {
    if (accept(message)) {
      messages.push(message);
    }
  };

  subscribe(name, record);

  return {
    [Symbol.dispose]: () => {
      unsubscribe(name, record);
    },
    messages,
  };
};

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const outcomeOf = async (call: Promise<unknown>) => {
  try {
    return { value: await call };
  } catch (error) {
    return { error: messageOf(error) };
  }
};

const startConnection = () => {
  const fromBrowser = new PassThrough();
  const written: string[] = [];
  const events: ConnectionEvent[] = [];
  const lifetime = new AbortController();

  const toBrowser = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      written.push(chunk.toString("utf-8"));
      done();
    },
  });

  const send = connectOverPipe({ fromBrowser, toBrowser }, lifetime.signal, (event) => {
    events.push(event);
  });

  return {
    chrome: (...messages: readonly Json[]) => {
      fromBrowser.write(framed(messages));
    },
    events,
    fromBrowser,
    lifetime,
    send,
    sent: () => written.join("").split("\0").slice(0, -1),
  };
};

type Harness = ReturnType<typeof startConnection> & { readonly caller: AbortController };

const startWithMainPage = () => {
  const connection = startConnection();

  connection.chrome(pageAttached("S1", "T1"));

  return connection;
};

const oversized = (head: string, tail: string): Buffer[] => [
  Buffer.from(head),
  ...Array.from({ length: OVER_THE_CAP_CHUNKS }, () => FILLER),
  Buffer.from(`${tail}\0`),
];

const navigation = {
  method: "Page.frameNavigated",
  params: { frame: { id: "T1", loaderId: "L1", url: "https://example.test/привет" } },
  sessionId: "S1",
};

const chunkings = [
  { chunk: (bytes: Buffer) => [bytes], name: "many messages in one chunk" },
  {
    chunk: (bytes: Buffer) => Array.from(bytes, (byte) => Buffer.from([byte])),
    name: "1-byte fragments",
  },
  {
    chunk: (bytes: Buffer) => {
      const split = bytes.indexOf(Buffer.from("и")) + 1;

      return [bytes.subarray(0, split), bytes.subarray(split)];
    },
    name: "a multi-byte character split across two chunks",
  },
];

const SETTLE_CASES = [
  {
    cause: "its reply",
    end: ({ chrome }: Harness) => {
      chrome({ id: 4, result: { frameId: "T1", loaderId: "L1" }, sessionId: "S1" });
    },
    notified: [],
    outcome: { value: { frameId: "T1", loaderId: "L1" } },
    sessionLives: true,
  },
  {
    cause: "a protocol error",
    end: ({ chrome }: Harness) => {
      chrome({ error: { code: -32_000, message: "Invalid URL" }, id: 4, sessionId: "S1" });
    },
    notified: [],
    outcome: { error: "Page.navigate failed: Invalid URL" },
    sessionLives: true,
  },
  {
    cause: "its signal",
    end: ({ caller }: Harness) => {
      caller.abort(new Error("Stopped by caller"));
    },
    notified: [],
    outcome: { error: "Stopped by caller" },
    sessionLives: true,
  },
  {
    cause: "an oversized reply",
    end: ({ fromBrowser }: Harness) => {
      for (const part of oversized('{"id":4,"result":{"frameId":"', '"},"sessionId":"S1"}')) {
        fromBrowser.write(part);
      }
    },
    notified: [],
    outcome: { error: "The reply to Page.navigate exceeded 32 MiB." },
    sessionLives: true,
  },
  {
    cause: "a reply that is not JSON",
    end: ({ fromBrowser }: Harness) => {
      fromBrowser.write('{"id":4,"result":{"frameId":\0');
    },
    notified: [],
    outcome: { error: "The reply to Page.navigate was malformed." },
    sessionLives: true,
  },
  {
    cause: "a reply of the wrong shape",
    end: ({ fromBrowser }: Harness) => {
      fromBrowser.write('{"id":4,"result":"navigated","sessionId":"S1"}\0');
    },
    notified: [],
    outcome: { error: "The reply to Page.navigate was malformed." },
    sessionLives: true,
  },
  {
    cause: "a renderer crash",
    end: ({ chrome }: Harness) => {
      chrome({ method: "Inspector.targetCrashed", params: {}, sessionId: "S1" });
    },
    notified: [{ crashed: true, target: MAIN, type: "ended" }],
    outcome: { error: GONE },
    sessionLives: false,
  },
  {
    cause: "its target detaching",
    end: ({ chrome }: Harness) => {
      chrome({
        method: "Target.detachedFromTarget",
        params: { sessionId: "S1", targetId: "T1" },
      });
    },
    notified: [{ crashed: false, target: MAIN, type: "ended" }],
    outcome: { error: GONE },
    sessionLives: false,
  },
  {
    cause: "Browser.close detaching it twice",
    end: ({ chrome }: Harness) => {
      chrome(
        {
          method: "Inspector.detached",
          params: { reason: "Render process gone." },
          sessionId: "S1",
        },
        { method: "Target.detachedFromTarget", params: { sessionId: "S1", targetId: "T1" } },
      );
    },
    notified: [{ crashed: false, target: MAIN, type: "ended" }],
    outcome: { error: GONE },
    sessionLives: false,
  },
  {
    cause: "the pipe closing",
    end: ({ fromBrowser }: Harness) => {
      fromBrowser.end();
    },
    notified: [{ type: "closed" }],
    outcome: { error: GONE },
    sessionLives: false,
  },
];

describe(connectOverPipe, () => {
  it.each(chunkings)("reads NUL-delimited messages from $name", async ({ chunk }) => {
    const { events, fromBrowser, send } = startConnection();
    const version = send(BROWSER, "Browser.getVersion", {}, AbortSignal.timeout(10_000));

    for (const part of chunk(
      framed([pageAttached("S1", "T1"), navigation, { id: 1, result: { product: "Chrome ✓" } }]),
    )) {
      fromBrowser.write(part);
    }

    await expect(version).resolves.toStrictEqual({ product: "Chrome ✓" });
    expect(events).toStrictEqual([
      { target: MAIN, type: "attached" },
      {
        event: { method: navigation.method, params: navigation.params },
        session: MAIN,
        type: "domain",
      },
    ]);
  });

  it("skips events nobody consumes without parsing them, and parses unfamiliar heads in full", async () => {
    using dropped = recordChannel("xrio:event", isInternalEvent);
    const { events, fromBrowser, send } = startWithMainPage();
    const version = send(BROWSER, "Browser.getVersion", {}, AbortSignal.timeout(10_000));

    fromBrowser.write('{"method":"Network.dataReceived","params":{"requestId":\0');
    fromBrowser.write('{"method":"Page.lifecycleEvent","params":{"requestId":\0');
    fromBrowser.write('{"sessionId":"S1","id":4,"result":{"product":"Chrome"}}\0');
    fromBrowser.write(
      '{"params":{"frameId":"T1","loaderId":"L1","name":"load"},"method":"Page.lifecycleEvent","sessionId":"S1"}\0',
    );

    await expect(version).resolves.toStrictEqual({ product: "Chrome" });
    expect(dropped.messages).toStrictEqual([
      {
        detail:
          "Dropped a Page.lifecycleEvent event that was malformed; 1 CDP messages dropped so far.",
        event: "cdp-message-dropped",
      },
    ]);
    expect(events.at(-1)).toStrictEqual({
      event: {
        method: "Page.lifecycleEvent",
        params: { frameId: "T1", loaderId: "L1", name: "load" },
      },
      session: MAIN,
      type: "domain",
    });
  });

  it("drops and counts events over 32 MiB, and keeps reading after them", () => {
    using dropped = recordChannel("xrio:event", isInternalEvent);
    const { chrome, events, fromBrowser } = startWithMainPage();

    const writeHugeRequest = () => {
      for (const part of oversized(
        '{"method":"Network.requestWillBeSent","params":{"request":{"url":"https://example.test/',
        '"}},"sessionId":"S1"}',
      )) {
        fromBrowser.write(part);
      }
    };

    writeHugeRequest();
    writeHugeRequest();
    chrome(navigation);

    expect(dropped.messages.map(({ detail }) => detail)).toStrictEqual([
      "Dropped a Network.requestWillBeSent event that exceeded 32 MiB; 1 CDP messages dropped so far.",
      "Dropped a Network.requestWillBeSent event that exceeded 32 MiB; 2 CDP messages dropped so far.",
    ]);
    expect(events.map(({ type }) => type)).toStrictEqual(["attached", "domain"]);
  });

  it("fails a call whose reply is over 32 MiB, and answers the next one", async () => {
    const { chrome, fromBrowser, send } = startConnection();
    const signal = AbortSignal.timeout(10_000);
    const huge = send(BROWSER, "Browser.getVersion", {}, signal);

    for (const part of oversized('{"id":1,"result":{"product":"', '"}}')) {
      fromBrowser.write(part);
    }

    const next = send(BROWSER, "Browser.getVersion", {}, signal);

    chrome({ id: 2, result: { product: "Chrome" } });

    await expect(huge).rejects.toThrow("The reply to Browser.getVersion exceeded 32 MiB.");
    await expect(next).resolves.toStrictEqual({ product: "Chrome" });
  });

  it.each(SETTLE_CASES)(
    "settles a call exactly once when $cause ends it",
    async ({ end, notified, outcome, sessionLives }) => {
      const harness = { ...startWithMainPage(), caller: new AbortController() };
      const { chrome, events, send, sent } = harness;

      const call = outcomeOf(
        send(MAIN, "Page.navigate", { url: "https://example.test/" }, harness.caller.signal),
      );

      end(harness);
      chrome({ id: 4, result: { frameId: "late", loaderId: "late" }, sessionId: "S1" });

      await expect(call).resolves.toStrictEqual(outcome);
      expect(events.filter(({ type }) => type === "ended" || type === "closed")).toStrictEqual(
        notified,
      );

      const later = outcomeOf(send(MAIN, "Page.enable", {}, AbortSignal.timeout(10_000)));

      if (sessionLives) {
        chrome({ id: 5, result: {}, sessionId: "S1" });
      }

      await expect(later).resolves.toStrictEqual(sessionLives ? { value: {} } : { error: GONE });
      expect(sent().filter((line) => line.includes('"method":"Page.enable"'))).toHaveLength(
        sessionLives ? 1 : 0,
      );
    },
  );

  it("refuses calls it could never settle without writing them", async () => {
    const { fromBrowser, send, sent } = startConnection();
    const unknownPage = outcomeOf(send(MAIN, "Page.enable", {}, AbortSignal.timeout(10_000)));

    const aborted = outcomeOf(
      send(BROWSER, "Browser.getVersion", {}, AbortSignal.abort(new Error("late"))),
    );

    fromBrowser.end();
    await once(fromBrowser, "end");

    await expect(unknownPage).resolves.toStrictEqual({ error: GONE });
    await expect(aborted).resolves.toStrictEqual({ error: "late" });
    await expect(
      outcomeOf(send(BROWSER, "Browser.getVersion", {}, AbortSignal.timeout(10_000))),
    ).resolves.toStrictEqual({ error: GONE });
    expect(sent()).toStrictEqual([]);
  });

  it("enables Network without body buffers and resumes every target it attaches", () => {
    const { chrome, events, sent } = startWithMainPage();

    chrome(
      pageAttached("S2", "T2"),
      childAttached("S1", "S3", "iframe"),
      childAttached("S1", "S4", "worker"),
      childAttached("S1", "S5", "auction_worklet"),
      {
        error: { code: -32_001, message: "Session with given id not found." },
        id: 10,
        sessionId: "S4",
      },
    );

    expect(events.map((event) => (event.type === "attached" ? event.target : event))).toStrictEqual(
      [
        MAIN,
        { id: "S2", scope: "popup", targetId: "T2" },
        { id: "S3", scope: "iframe", targetId: "iframe-target" },
        { id: "S4", scope: "worker", targetId: "worker-target" },
        { id: "S5", scope: "other", targetId: "auction_worklet-target" },
      ],
    );
    expect(sent()).toStrictEqual([
      '{"id":1,"method":"Network.enable","params":{"maxResourceBufferSize":0,"maxTotalBufferSize":0},"sessionId":"S1"}',
      '{"id":2,"method":"Target.setAutoAttach","params":{"autoAttach":true,"flatten":true,"waitForDebuggerOnStart":true},"sessionId":"S1"}',
      '{"id":3,"method":"Runtime.runIfWaitingForDebugger","params":{},"sessionId":"S1"}',
      '{"id":4,"method":"Network.enable","params":{"maxResourceBufferSize":0,"maxTotalBufferSize":0},"sessionId":"S2"}',
      '{"id":5,"method":"Target.setAutoAttach","params":{"autoAttach":true,"flatten":true,"waitForDebuggerOnStart":true},"sessionId":"S2"}',
      '{"id":6,"method":"Runtime.runIfWaitingForDebugger","params":{},"sessionId":"S2"}',
      '{"id":7,"method":"Network.enable","params":{"maxResourceBufferSize":0,"maxTotalBufferSize":0},"sessionId":"S3"}',
      '{"id":8,"method":"Target.setAutoAttach","params":{"autoAttach":true,"flatten":true,"waitForDebuggerOnStart":true},"sessionId":"S3"}',
      '{"id":9,"method":"Runtime.runIfWaitingForDebugger","params":{},"sessionId":"S3"}',
      '{"id":10,"method":"Network.enable","params":{"maxResourceBufferSize":0,"maxTotalBufferSize":0},"sessionId":"S4"}',
      '{"id":11,"method":"Target.setAutoAttach","params":{"autoAttach":true,"flatten":true,"waitForDebuggerOnStart":true},"sessionId":"S4"}',
      '{"id":12,"method":"Runtime.runIfWaitingForDebugger","params":{},"sessionId":"S4"}',
      '{"id":13,"method":"Network.enable","params":{"maxResourceBufferSize":0,"maxTotalBufferSize":0},"sessionId":"S5"}',
      '{"id":14,"method":"Runtime.runIfWaitingForDebugger","params":{},"sessionId":"S5"}',
    ]);
  });

  it("taps each command's scope and method, never its params", () => {
    using tapped = recordChannel("xrio:cdp-command", isSentCommand);
    const { send } = startWithMainPage();

    void send(
      MAIN,
      "Page.navigate",
      { url: "https://user:secret@example.test/" },
      AbortSignal.timeout(10_000),
    );

    expect(tapped.messages).toStrictEqual([
      { method: "Network.enable", scope: "main" },
      { method: "Target.setAutoAttach", scope: "main" },
      { method: "Runtime.runIfWaitingForDebugger", scope: "main" },
      { method: "Page.navigate", scope: "main" },
    ]);
  });
});
