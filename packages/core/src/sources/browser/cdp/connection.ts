import { channel } from "node:diagnostics_channel";
import type { Readable, Writable } from "node:stream";

import { publishInternalEvent } from "../../../diagnostics.ts";
import { DriverError } from "../port.ts";
import { CONSUMED_EVENTS, isFrameHost } from "./protocol.ts";
import type {
  AnyTargetSession,
  ConsumedMethod,
  DomainEvent,
  Method,
  ParamsOf,
  ResultOf,
  Scope,
  Send,
  TargetScope,
} from "./protocol.ts";

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const HEAD_BYTES = 96;

const REPLY_HEAD = /^\{"id":(?<id>\d+)[,}]/u;

const EVENT_HEAD = /^\{"method":"(?<method>[^"]+)"/u;

const SESSION_EVENTS = [
  "Inspector.detached",
  "Inspector.targetCrashed",
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
] as const;

const PARSED_EVENTS: ReadonlySet<string> = new Set([...CONSUMED_EVENTS, ...SESSION_EVENTS]);

const CONSUMED: ReadonlySet<string> = new Set(CONSUMED_EVENTS);

const CHILD_SCOPES = [
  "iframe",
  "worker",
  "service_worker",
  "shared_worker",
] as const satisfies readonly TargetScope[];

const NO_BODY_BUFFERS: ParamsOf<"Network.enable", "worker"> = {
  maxResourceBufferSize: 0,
  maxTotalBufferSize: 0,
};

const EVERY_CHILD: ParamsOf<"Target.setAutoAttach", "iframe"> = {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: true,
};

const commands = channel("xrio:cdp-command");

export interface PipeStreams {
  readonly toBrowser: Writable;
  readonly fromBrowser: Readable;
}

export type ConnectionEvent =
  | { readonly type: "attached"; readonly target: AnyTargetSession }
  | { readonly type: "ended"; readonly target: AnyTargetSession; readonly crashed: boolean }
  | { readonly type: "domain"; readonly session: AnyTargetSession; readonly event: DomainEvent }
  | { readonly type: "closed" };

export type ConnectionListener = (event: ConnectionEvent, send: Send) => void;

interface SentCommand {
  readonly method: Method;
  readonly scope: Scope;
}

interface Envelope {
  readonly sessionId?: string;
}

interface Failure {
  readonly message: string;
}

interface Reply extends Envelope {
  readonly id: number;
  readonly result?: object;
  readonly error?: Failure;
}

interface RawEvent extends Envelope {
  readonly method: string;
  readonly params: object;
}

interface Attachment {
  readonly sessionId: string;
  readonly targetInfo: { readonly targetId: string; readonly type: string };
}

interface PendingCall {
  readonly method: Method;
  readonly sessionId: string | undefined;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  readonly settle: PromiseWithResolvers<object>;
}

type Framing =
  | { readonly kind: "buffering"; readonly parts: Buffer[]; bytes: number }
  | { readonly kind: "oversized"; readonly head: string };

type FrameHead =
  | { readonly kind: "reply"; readonly id: number }
  | { readonly kind: "event"; readonly method: string }
  | { readonly kind: "unrecognised" };

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const isEnvelope = (value: unknown): value is Envelope =>
  isObject(value) && (!("sessionId" in value) || typeof value.sessionId === "string");

const isFailure = (value: unknown): value is Failure =>
  isObject(value) && "message" in value && typeof value.message === "string";

const isReply = (value: unknown): value is Reply =>
  isEnvelope(value) &&
  "id" in value &&
  typeof value.id === "number" &&
  (("result" in value && isObject(value.result)) || ("error" in value && isFailure(value.error)));

const isEvent = (value: unknown): value is RawEvent =>
  isEnvelope(value) &&
  "method" in value &&
  typeof value.method === "string" &&
  "params" in value &&
  isObject(value.params);

const isTargetInfo = (value: unknown): value is Attachment["targetInfo"] =>
  isObject(value) &&
  "targetId" in value &&
  typeof value.targetId === "string" &&
  "type" in value &&
  typeof value.type === "string";

const isAttachment = (value: unknown): value is Attachment =>
  isObject(value) &&
  "sessionId" in value &&
  typeof value.sessionId === "string" &&
  "targetInfo" in value &&
  isTargetInfo(value.targetInfo);

const isDetachment = (value: unknown): value is { readonly sessionId: string } =>
  isObject(value) && "sessionId" in value && typeof value.sessionId === "string";

const isConsumed = (method: string): method is ConsumedMethod => CONSUMED.has(method);

const isChildScope = (type: string): type is (typeof CHILD_SCOPES)[number] =>
  CHILD_SCOPES.some((scope) => scope === type);

const readHead = (head: string): FrameHead => {
  const id = REPLY_HEAD.exec(head)?.groups?.id;

  if (id !== undefined) {
    return { id: Number(id), kind: "reply" };
  }

  const method = EVENT_HEAD.exec(head)?.groups?.method;

  return method === undefined ? { kind: "unrecognised" } : { kind: "event", method };
};

const headOf = (parts: readonly Buffer[]): string => {
  const head: Buffer[] = [];
  let bytes = 0;

  for (const part of parts) {
    if (bytes >= HEAD_BYTES) {
      break;
    }

    head.push(part);
    bytes += part.length;
  }

  return Buffer.concat(head, Math.min(bytes, HEAD_BYTES)).toString("latin1");
};

const buffering = (): Framing => ({ bytes: 0, kind: "buffering", parts: [] });

const browserGone = (): DriverError => new DriverError({ kind: "browser-gone" });

const settleQuietly = async (operations: readonly Promise<unknown>[]): Promise<void> => {
  await Promise.allSettled(operations);
};

class PipeConnection {
  readonly #streams: PipeStreams;
  readonly #lifetime: AbortSignal;
  readonly #listener: ConnectionListener;
  readonly #pending = new Map<number, PendingCall>();
  readonly #sessions = new Map<string, AnyTargetSession>();
  #framing = buffering();
  #nextId = 1;
  #mainClaimed = false;
  #dropped = 0;
  #closed = false;

  constructor(streams: PipeStreams, lifetime: AbortSignal, listener: ConnectionListener) {
    this.#streams = streams;
    this.#lifetime = lifetime;
    this.#listener = listener;
    streams.fromBrowser.on("data", (chunk: Buffer) => {
      this.#read(chunk);
    });

    for (const ended of ["end", "close", "error"]) {
      streams.fromBrowser.on(ended, () => {
        this.#close();
      });
    }

    streams.toBrowser.on("error", () => {
      this.#close();
    });
  }

  readonly send: Send = async (session, method, params, signal) => {
    const sessionId = "id" in session ? session.id : undefined;

    if (this.#closed || (sessionId !== undefined && !this.#sessions.has(sessionId))) {
      throw browserGone();
    }

    signal.throwIfAborted();
    const id = this.#nextId;
    const settle = Promise.withResolvers<object>();

    const onAbort = () => {
      this.#take(id)?.settle.reject(signal.reason);
    };

    this.#nextId += 1;
    this.#pending.set(id, { method, onAbort, sessionId, settle, signal });
    signal.addEventListener("abort", onAbort, { once: true });
    this.#streams.toBrowser.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);

    if (commands.hasSubscribers) {
      commands.publish({ method, scope: session.scope } satisfies SentCommand);
    }

    const result = await settle.promise;

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the reply carries this call's id, and Chrome answers each method with that method's protocol result.
    return result as ResultOf<typeof method>;
  };

  #take(id: number): PendingCall | undefined {
    const call = this.#pending.get(id);

    if (call !== undefined) {
      this.#pending.delete(id);
      call.signal.removeEventListener("abort", call.onAbort);
    }

    return call;
  }

  #drop(what: string): void {
    this.#dropped += 1;
    publishInternalEvent({
      detail: `Dropped ${what}; ${this.#dropped} CDP messages dropped so far.`,
      event: "cdp-message-dropped",
    });
  }

  #endSession(sessionId: string | undefined, crashed: boolean): void {
    const target = sessionId === undefined ? undefined : this.#sessions.get(sessionId);

    if (target === undefined) {
      return;
    }

    this.#sessions.delete(target.id);

    for (const [id, call] of this.#pending) {
      if (call.sessionId === target.id) {
        this.#take(id)?.settle.reject(browserGone());
      }
    }

    this.#listener({ crashed, target, type: "ended" }, this.send);
  }

  #close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;

    for (const id of this.#pending.keys()) {
      this.#take(id)?.settle.reject(browserGone());
    }

    this.#listener({ type: "closed" }, this.send);
  }

  #scopeOf(type: string): TargetScope {
    if (type !== "page") {
      return isChildScope(type) ? type : "other";
    }

    const scope = this.#mainClaimed ? "popup" : "main";

    this.#mainClaimed = true;

    return scope;
  }

  #attach({ sessionId, targetInfo }: Attachment): void {
    const target: AnyTargetSession = {
      id: sessionId,
      scope: this.#scopeOf(targetInfo.type),
      targetId: targetInfo.targetId,
    };

    this.#sessions.set(sessionId, target);

    void settleQuietly([
      this.send(target, "Network.enable", NO_BODY_BUFFERS, this.#lifetime),
      ...(isFrameHost(target)
        ? [this.send(target, "Target.setAutoAttach", EVERY_CHILD, this.#lifetime)]
        : []),
      this.send(target, "Runtime.runIfWaitingForDebugger", {}, this.#lifetime),
    ]);

    this.#listener({ target, type: "attached" }, this.send);
  }

  #deliver({ method, params, sessionId }: RawEvent): void {
    const session = sessionId === undefined ? undefined : this.#sessions.get(sessionId);

    if (session !== undefined && isConsumed(method)) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the method is one we consume, and Chrome sends each event with that event's protocol params.
      const event = { method, params } as DomainEvent;

      this.#listener({ event, session, type: "domain" }, this.send);
    }
  }

  #route(message: RawEvent): void {
    switch (message.method) {
      case "Target.attachedToTarget": {
        if (isAttachment(message.params)) {
          this.#attach(message.params);
        }

        break;
      }

      case "Target.detachedFromTarget": {
        if (isDetachment(message.params)) {
          this.#endSession(message.params.sessionId, false);
        }

        break;
      }

      case "Inspector.detached": {
        this.#endSession(message.sessionId, false);
        break;
      }

      case "Inspector.targetCrashed": {
        this.#endSession(message.sessionId, true);
        break;
      }

      default: {
        this.#deliver(message);
      }
    }
  }

  #answer({ error, id, result }: Reply): void {
    const call = this.#take(id);

    if (call === undefined) {
      return;
    }

    if (error === undefined) {
      call.settle.resolve(result ?? {});
    } else {
      call.settle.reject(new Error(`${call.method} failed: ${error.message}`));
    }
  }

  #parse(frame: Buffer, head: FrameHead): void {
    let message: unknown;

    try {
      message = JSON.parse(frame.toString("utf-8"));
    } catch {
      message = undefined;
    }

    if (isReply(message)) {
      this.#answer(message);
    } else if (isEvent(message)) {
      this.#route(message);
    } else {
      this.#refuse(head, "was malformed");
    }
  }

  #dispatch(frame: Buffer): void {
    const head = readHead(frame.toString("latin1", 0, HEAD_BYTES));

    if (head.kind !== "event" || PARSED_EVENTS.has(head.method)) {
      this.#parse(frame, head);
    }
  }

  #refuse(head: FrameHead, problem: string): void {
    const call = head.kind === "reply" ? this.#take(head.id) : undefined;

    if (call !== undefined) {
      call.settle.reject(new Error(`The reply to ${call.method} ${problem}.`));

      return;
    }

    this.#drop(
      `${head.kind === "event" ? `a ${head.method} event` : "a CDP message"} that ${problem}`,
    );
  }

  #accept(segment: Buffer): void {
    if (this.#framing.kind === "oversized") {
      return;
    }

    this.#framing.parts.push(segment);
    this.#framing.bytes += segment.length;

    if (this.#framing.bytes > MAX_MESSAGE_BYTES) {
      this.#framing = { head: headOf(this.#framing.parts), kind: "oversized" };
    }
  }

  #complete(): void {
    const frame = this.#framing;

    this.#framing = buffering();

    if (frame.kind === "oversized") {
      this.#refuse(readHead(frame.head), "exceeded 32 MiB");
    } else if (frame.bytes > 0) {
      const [first = Buffer.alloc(0)] = frame.parts;

      this.#dispatch(frame.parts.length === 1 ? first : Buffer.concat(frame.parts, frame.bytes));
    }
  }

  #read(chunk: Buffer): void {
    if (this.#closed) {
      return;
    }

    let start = 0;

    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
      this.#accept(chunk.subarray(start, end));
      this.#complete();
      start = end + 1;
    }

    if (start < chunk.length) {
      this.#accept(chunk.subarray(start));
    }
  }
}

export const connectOverPipe = (
  streams: PipeStreams,
  lifetime: AbortSignal,
  listener: ConnectionListener,
): Send => new PipeConnection(streams, lifetime, listener).send;
