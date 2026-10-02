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

const CONTEXT_GONE = /Cannot find context with specified id|Execution context was destroyed/u;

interface CommittedDocument {
  readonly loaderId: string;
  readonly replaced: AbortController;
  readonly world: Promise<IsolatedContextId>;
}

interface Connected {
  readonly send: Send;
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
  readonly #frame: MainFrameEvents;
  readonly #listeners = new Set<DriverListener>();
  readonly #ready: Promise<unknown>;
  #document: CommittedDocument | undefined;

  constructor(send: Send, main: TargetSession<"main">, lifetime: AbortSignal) {
    this.#send = send;
    this.#main = main;
    this.#lifetime = lifetime;
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

    const { errorText = "" } = await this.#send(
      this.#main,
      "Page.navigate",
      { url },
      deadline.signal,
    );

    if (errorText !== "") {
      throw new DriverError({ kind: "navigation-failed", netError: errorText });
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

  receive(event: ConnectionEvent): void {
    if (event.type === "domain") {
      this.#receiveDomain(event.session, event.event);
    } else if (event.type === "closed") {
      this.#emit({ type: "disconnect" });
    } else if (event.type === "ended" && event.target.id === this.#main.id) {
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
      const superseded =
        this.#document !== document && !deadline.signal.aborted && !(error instanceof DriverError);

      throw superseded
        ? new DriverError({ kind: "document-replaced" }, { cause: error })
        : (replacedBy(error) ?? error);
    }
  }

  #receiveDomain(session: AnyTargetSession, event: DomainEvent): void {
    if (event.method === "Page.javascriptDialogOpening") {
      void settle(
        this.#send(this.#main, "Page.handleJavaScriptDialog", { accept: false }, this.#lifetime),
      );

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
  send: Send,
  chrome: SpawnedBrowser,
  budgetMs: number,
): Promise<void> => {
  void settle(send(BROWSER, "Browser.close", {}, AbortSignal.timeout(budgetMs)));
  await chrome.stop(budgetMs);
};

const connect = (chrome: SpawnedBrowser, lifetime: AbortSignal): Connected => {
  const firstTab = Promise.withResolvers<Tab>();
  let tab: Tab | undefined;

  const send = connectOverPipe(chrome.pipe, lifetime, (event, reply) => {
    if (event.type === "attached" && event.target.scope === "main") {
      tab = new Tab(reply, event.target, lifetime);
      firstTab.resolve(tab);

      return;
    }

    if (event.type === "closed") {
      firstTab.reject(new DriverError({ kind: "browser-gone" }));
    }

    tab?.receive(event);
  });

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
        await closeBrowser(send, chrome, budgetMs);
      },
      evaluateIsolated: opener.evaluateIsolated,
      navigate: opener.navigate,
      onEvent: opener.onEvent,
      pid: chrome.pid,
      product,
    };
  })();

  void settle(opened);

  return { opened, send };
};

const withStderr = async (chrome: SpawnedBrowser, problem: string, cause: unknown) =>
  new Error(`${problem}\n${await chrome.stderrTail()}`, { cause });

export const cdpDriver: BrowserDriver = {
  launch: async (plan, deadline, deferCleanup) => {
    using stage = deadline.startStage(LAUNCH_TIMEOUT_MS);
    const chrome = await spawnBrowser(plan);
    const { opened, send } = connect(chrome, deadline.signal);

    try {
      return await untilAborted(opened, stage.signal);
    } catch (error) {
      deferCleanup(closeBrowser(send, chrome, CLOSE_BUDGET_MS));

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
