import { randomInt } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import type { Deadline } from "../../../deadline.ts";
import { spawnBrowser } from "../browser-process.ts";
import type { SpawnedBrowser } from "../browser-process.ts";
import { CLOSE_BUDGET_MS, DriverError } from "../port.ts";
import type {
  BrowserDriver,
  DriverBrowser,
  DriverEvent,
  DriverListener,
  ResultGuard,
} from "../port.ts";
import { connectOverPipe } from "./connection.ts";
import type { ConnectionEvent } from "./connection.ts";
import { MainFrameEvents } from "./page-events.ts";
import { BROWSER } from "./protocol.ts";
import type {
  AnyTargetSession,
  DomainEvent,
  IsolatedContextId,
  ParamsOf,
  ResultOf,
  Send,
  TargetSession,
} from "./protocol.ts";

const PAGES_ONLY: ParamsOf<"Target.setAutoAttach", "browser"> = {
  autoAttach: true,
  filter: [{ type: "page" }],
  flatten: true,
  waitForDebuggerOnStart: true,
};

const LAUNCH_TIMEOUT_MS = 30_000;

const DOWNLOAD_SETTLE_MS = 500;

const NAVIGATION_DOWNLOAD = "navigation";

const DIALOG_DISMISS_MS = { longest: 1500, shortest: 600 } as const;

const CONTEXT_GONE = /Cannot find context with specified id|Execution context was destroyed/u;

const NAVIGATED_AWAY = /Inspected target navigated or closed/u;

interface CommittedDocument {
  readonly loaderId: string;
  readonly replaced: AbortController;
  readonly world: Promise<IsolatedContextId>;
}

interface Connection {
  readonly send: Send;
  readonly isOpen: () => boolean;
}

interface Connected extends Connection {
  readonly opened: Promise<DriverBrowser>;
}

const settle = async (operation: Promise<unknown>): Promise<void> => {
  await Promise.allSettled([operation]);
};

const untilAborted = async <Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> => {
  const aborted = Promise.withResolvers<never>();

  const abort = () => {
    aborted.reject(signal.reason);
  };

  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) {
    abort();
  }

  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

const settleWithin = async (operation: Promise<unknown>, budgetMs: number): Promise<void> => {
  await settle(untilAborted(operation, AbortSignal.timeout(budgetMs)));
};

const whenAborted = async (signal: AbortSignal): Promise<void> => {
  if (!signal.aborted) {
    await once(signal, "abort");
  }
};

const isNavigatedAway = (cause: unknown): boolean =>
  cause instanceof Error && NAVIGATED_AWAY.test(cause.message);

const isBrowserGone = (cause: unknown): boolean =>
  cause instanceof DriverError && cause.reason.kind === "browser-gone";

const replacedBy = (cause: unknown): DriverError | undefined =>
  cause instanceof Error && CONTEXT_GONE.test(cause.message)
    ? new DriverError({ kind: "document-replaced" }, { cause })
    : undefined;

class Tab {
  readonly #send: Send;
  readonly #main: TargetSession<"main">;
  readonly #lifetime: AbortSignal;
  readonly #ended = new AbortController();
  readonly #alive: AbortSignal;
  readonly #frame: MainFrameEvents;
  readonly #listeners = new Set<DriverListener>();
  readonly #ready: Promise<unknown>;
  readonly #downloads = new Set<string>();
  #downloadsIdle = Promise.withResolvers<"idle">();
  #navigated = false;
  #document: CommittedDocument | undefined;

  constructor(send: Send, main: TargetSession<"main">, lifetime: AbortSignal) {
    this.#send = send;
    this.#main = main;
    this.#lifetime = lifetime;
    this.#alive = AbortSignal.any([lifetime, this.#ended.signal]);
    this.#frame = new MainFrameEvents(main);
    this.#ready = Promise.all([
      send(main, "Page.enable", {}, lifetime),
      send(main, "Page.setLifecycleEventsEnabled", { enabled: true }, lifetime),
    ]);
    void settle(this.#ready);
    void settle(send(main, "Page.bringToFront", {}, lifetime));
  }

  readonly onEvent = (listener: DriverListener): (() => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly navigate = async (url: string, deadline: Deadline): Promise<void> => {
    deadline.throwIfExpired();
    await untilAborted(this.#ready, deadline.signal);
    this.#navigated = true;

    const { errorText = "", isDownload = false } = await this.#send(
      this.#main,
      "Page.navigate",
      { url },
      deadline.signal,
    );

    if (isDownload) {
      this.#downloadStarted(NAVIGATION_DOWNLOAD);
    }

    if (errorText !== "") {
      throw new DriverError({ kind: "navigation-failed", netError: errorText });
    }
  };

  readonly downloadsSettled = async (budgetMs: number): Promise<void> => {
    if (this.#downloads.size > 0) {
      await settleWithin(this.#downloadsIdle.promise, budgetMs);
    }
  };

  readonly evaluateIsolated = async <Result>(
    expression: string,
    isResult: ResultGuard<Result>,
    deadline: Deadline,
  ): Promise<Result> => {
    deadline.throwIfExpired();
    const document = this.#document;

    if (document === undefined) {
      throw new DriverError({ kind: "document-replaced" });
    }

    const { exceptionDetails, result } = await this.#evaluate(document, expression, deadline);

    if (exceptionDetails !== undefined) {
      throw new Error("The isolated evaluate threw.");
    }

    const value: unknown = result.value;

    if (!isResult(value)) {
      throw new Error("The isolated evaluate returned an unexpected value.");
    }

    return value;
  };

  readonly end = (): void => {
    this.#ended.abort(new DriverError({ kind: "browser-gone" }));
  };

  receive(event: ConnectionEvent): void {
    if (event.type === "domain") {
      this.#receiveDomain(event.session, event.event);
    } else if (event.type === "closed") {
      this.end();
      this.#emit({ type: "disconnect" });
    } else if (event.type === "ended" && event.target.id === this.#main.id) {
      this.end();
      this.#emit({ type: event.crashed ? "crash" : "disconnect" });
    }
  }

  async #evaluate(
    document: CommittedDocument,
    expression: string,
    deadline: Deadline,
  ): Promise<ResultOf<"Runtime.evaluate">> {
    const signal = AbortSignal.any([deadline.signal, document.replaced.signal]);

    try {
      const contextId = await untilAborted(document.world, signal);
      const params = { contextId, expression, returnByValue: true } as const;

      return await this.#send(this.#main, "Runtime.evaluate", params, signal);
    } catch (error) {
      if (isNavigatedAway(error)) {
        await this.#replacementOf(document, deadline);

        throw new DriverError({ kind: "document-replaced" }, { cause: error });
      }

      const superseded =
        this.#document !== document && !deadline.signal.aborted && !(error instanceof DriverError);

      throw superseded
        ? new DriverError({ kind: "document-replaced" }, { cause: error })
        : (replacedBy(error) ?? error);
    }
  }

  async #replacementOf(document: CommittedDocument, deadline: Deadline): Promise<void> {
    await whenAborted(
      AbortSignal.any([document.replaced.signal, deadline.signal, this.#ended.signal]),
    );

    if (document.replaced.signal.aborted) {
      return;
    }

    deadline.throwIfExpired();

    throw new DriverError({ kind: "browser-gone" });
  }

  #receiveDomain(session: AnyTargetSession, event: DomainEvent): void {
    if (event.method === "Page.javascriptDialogOpening") {
      void settle(this.#dismissDialog());

      return;
    }

    if (event.method === "Page.downloadWillBegin") {
      this.#downloadStarted(event.params.guid);

      if (event.params.frameId === this.#main.targetId) {
        this.#downloadEnded(NAVIGATION_DOWNLOAD);
      }

      return;
    }

    if (event.method === "Page.downloadProgress") {
      if (event.params.state !== "inProgress") {
        this.#downloadEnded(event.params.guid);
      }

      return;
    }

    this.#receivePageEvent(session, event);
  }

  async #dismissDialog(): Promise<void> {
    const pause = randomInt(DIALOG_DISMISS_MS.shortest, DIALOG_DISMISS_MS.longest + 1);

    await delay(pause, undefined, { signal: this.#alive });
    await this.#send(this.#main, "Page.handleJavaScriptDialog", { accept: false }, this.#alive);
  }

  #downloadStarted(key: string): void {
    if (this.#downloads.size === 0) {
      this.#downloadsIdle = Promise.withResolvers<"idle">();
    }

    this.#downloads.add(key);
  }

  #downloadEnded(key: string): void {
    if (this.#downloads.delete(key) && this.#downloads.size === 0) {
      this.#downloadsIdle.resolve("idle");
    }
  }

  #receivePageEvent(
    session: AnyTargetSession,
    event: Parameters<MainFrameEvents["translate"]>[1],
  ): void {
    if (!this.#navigated) {
      return;
    }

    for (const driverEvent of this.#frame.translate(session, event)) {
      if (driverEvent.type === "commit") {
        this.#adopt(driverEvent.loaderId);
      }

      this.#emit(driverEvent);
    }
  }

  #adopt(loaderId: string): void {
    if (this.#document?.loaderId === loaderId) {
      return;
    }

    this.#document?.replaced.abort(new DriverError({ kind: "document-replaced" }));
    const replaced = new AbortController();
    const world = this.#createWorld(AbortSignal.any([this.#lifetime, replaced.signal]));

    void settle(world);
    this.#document = { loaderId, replaced, world };
  }

  async #createWorld(signal: AbortSignal): Promise<IsolatedContextId> {
    const { executionContextId } = await this.#send(
      this.#main,
      "Page.createIsolatedWorld",
      { frameId: this.#main.targetId, worldName: "" },
      signal,
    );

    return executionContextId;
  }

  #emit(event: DriverEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}

const closeBrowser = async (
  { isOpen, send }: Connection,
  chrome: SpawnedBrowser,
  budgetMs: number,
): Promise<void> => {
  if (!isOpen()) {
    await chrome.kill(budgetMs);

    return;
  }

  void settle(send(BROWSER, "Browser.close", {}, AbortSignal.timeout(budgetMs)));
  await chrome.stop(budgetMs);
};

const connect = (chrome: SpawnedBrowser, lifetime: AbortSignal): Connected => {
  const firstTab = Promise.withResolvers<Tab>();
  let tab: Tab | undefined;
  let open = true;

  const send = connectOverPipe(chrome.pipe, lifetime, (event, reply) => {
    if (event.type === "attached" && event.target.scope === "main") {
      tab = new Tab(reply, event.target, lifetime);
      firstTab.resolve(tab);

      return;
    }

    if (event.type === "closed") {
      open = false;
      firstTab.reject(new DriverError({ kind: "browser-gone" }));
    }

    tab?.receive(event);
  });

  const connection: Connection = { isOpen: () => open, send };

  const opened = (async (): Promise<DriverBrowser> => {
    const configured = Promise.all([
      send(BROWSER, "Browser.setDownloadBehavior", { behavior: "deny" }, lifetime),
      send(BROWSER, "Target.setAutoAttach", PAGES_ONLY, lifetime),
    ]);

    const [opener, { product }] = await Promise.all([
      firstTab.promise,
      send(BROWSER, "Browser.getVersion", {}, lifetime),
      configured,
    ]);

    return {
      close: async (budgetMs) => {
        opener.end();
        await opener.downloadsSettled(DOWNLOAD_SETTLE_MS);
        await closeBrowser(connection, chrome, budgetMs);
      },
      evaluateIsolated: opener.evaluateIsolated,
      navigate: opener.navigate,
      onEvent: opener.onEvent,
      pid: chrome.pid,
      product,
    };
  })();

  void settle(opened);

  return { ...connection, opened };
};

const withStderr = async (chrome: SpawnedBrowser, problem: string, cause: unknown) =>
  new Error(`${problem}\n${await chrome.stderrTail()}`, { cause });

export const cdpDriver: BrowserDriver = {
  launch: async (plan, deadline, deferCleanup) => {
    using stage = deadline.startStage(LAUNCH_TIMEOUT_MS);
    const chrome = await spawnBrowser(plan);
    const { opened, ...connection } = connect(chrome, deadline.signal);

    try {
      return await untilAborted(opened, stage.signal);
    } catch (error) {
      deferCleanup(closeBrowser(connection, chrome, CLOSE_BUDGET_MS));

      if (isBrowserGone(error)) {
        throw await withStderr(chrome, "Chrome exited during launch.", error);
      }

      if (stage.signal.aborted && !deadline.signal.aborted) {
        throw await withStderr(
          chrome,
          `Chrome opened no page within ${LAUNCH_TIMEOUT_MS} ms.`,
          error,
        );
      }

      throw error;
    }
  },
};
