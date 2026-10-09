import { describe, expectTypeOf, it } from "vite-plus/test";

import { BROWSER } from "./protocol.ts";
import type { IsolatedContextId, ParamsOf, Send, TargetSession } from "./protocol.ts";

declare const send: Send;

declare const main: TargetSession<"main">;

declare const popup: TargetSession<"popup">;

declare const iframe: TargetSession<"iframe">;

declare const worker: TargetSession<"worker">;

declare const serviceWorker: TargetSession<"service_worker">;

declare const world: IsolatedContextId;

declare const signal: AbortSignal;

const PAGES_ONLY: ParamsOf<"Target.setAutoAttach", "browser"> = {
  autoAttach: true,
  filter: [{ type: "page" }],
  flatten: true,
  waitForDebuggerOnStart: true,
};

const EVERY_CHILD: ParamsOf<"Target.setAutoAttach", "iframe"> = {
  autoAttach: true,
  flatten: true,
  waitForDebuggerOnStart: true,
};

describe("the CDP commands our driver may send", () => {
  it("compiles only the allowlisted methods, scopes and params", () => {
    expectTypeOf(
      send(
        main,
        "Runtime.evaluate",
        { awaitPromise: true, contextId: world, expression: "1", returnByValue: true },
        signal,
      ),
    ).resolves.toHaveProperty("result");
    expectTypeOf(
      send(main, "Page.createIsolatedWorld", { frameId: "F", worldName: "" }, signal),
    ).resolves.toEqualTypeOf<{ readonly executionContextId: IsolatedContextId }>();
    expectTypeOf(send(BROWSER, "Browser.getVersion", {}, signal)).resolves.toHaveProperty(
      "product",
    );
    expectTypeOf(send(BROWSER, "Target.setAutoAttach", PAGES_ONLY, signal)).resolves.toBeVoid();
    expectTypeOf(send(iframe, "Target.setAutoAttach", EVERY_CHILD, signal)).resolves.toBeVoid();
    expectTypeOf(send(worker, "Target.setAutoAttach", EVERY_CHILD, signal)).resolves.toBeVoid();
    expectTypeOf(
      send(worker, "Network.enable", { maxResourceBufferSize: 0, maxTotalBufferSize: 0 }, signal),
    ).resolves.toBeVoid();
    expectTypeOf(
      send(
        main,
        "Network.enable",
        { maxResourceBufferSize: 65_536, maxTotalBufferSize: 1_048_576 },
        signal,
      ),
    ).resolves.toBeVoid();

    expectTypeOf(
      send(
        main,
        "Network.setCookies",
        { cookies: [{ name: "seed", url: "https://example.com/", value: "one" }] },
        signal,
      ),
    ).resolves.toBeVoid();
    // @ts-expect-error Cookie seeding belongs only to the main page.
    void send(worker, "Network.setCookies", { cookies: [] }, signal);
    // @ts-expect-error Extra headers would leak across third-party browser requests.
    void send(main, "Network.setExtraHTTPHeaders", { headers: {} }, signal);

    // @ts-expect-error Runtime.enable is never sent.
    void send(main, "Runtime.enable", {}, signal);
    // @ts-expect-error Emulation is never sent, focus emulation included.
    void send(main, "Emulation.setFocusEmulationEnabled", { enabled: true }, signal);
    void send(
      main,
      "Runtime.evaluate",
      // @ts-expect-error A plain number could name the main world.
      { awaitPromise: true, contextId: 1, expression: "1", returnByValue: true },
      signal,
    );
    void send(
      main,
      "Runtime.evaluate",
      {
        awaitPromise: true,
        contextId: world,
        expression: "1",
        returnByValue: true,
        // @ts-expect-error Evaluates never claim a user gesture.
        userGesture: true,
      },
      signal,
    );
    // @ts-expect-error Popups are left alone; only the main page navigates.
    void send(popup, "Page.navigate", { url: "https://example.com" }, signal);
    // @ts-expect-error Workers have no Page domain.
    void send(worker, "Page.navigate", { url: "https://example.com" }, signal);
    // @ts-expect-error Browser commands go to the browser session only.
    void send(main, "Browser.getVersion", {}, signal);
    // @ts-expect-error Dialogs are dismissed, never accepted.
    void send(main, "Page.handleJavaScriptDialog", { accept: true }, signal);
    // @ts-expect-error Every call is bounded by a signal.
    void send(BROWSER, "Browser.getVersion", {});
    // @ts-expect-error The browser attaches pages only, so service workers stay unattached.
    void send(BROWSER, "Target.setAutoAttach", EVERY_CHILD, signal);
    // @ts-expect-error Children attach everything below them.
    void send(main, "Target.setAutoAttach", PAGES_ONLY, signal);
    // @ts-expect-error Service workers do not auto-attach.
    void send(serviceWorker, "Target.setAutoAttach", EVERY_CHILD, signal);
    // @ts-expect-error Only the main page buffers bodies, so workers never do.
    void send(worker, "Network.enable", {}, signal);
    void send(
      worker,
      "Network.enable",
      // @ts-expect-error Only the main page buffers bodies, so workers never do.
      { maxResourceBufferSize: 65_536, maxTotalBufferSize: 1_048_576 },
      signal,
    );
    // @ts-expect-error The main page buffers bodies for the content-type preview.
    void send(main, "Network.enable", { maxResourceBufferSize: 0, maxTotalBufferSize: 0 }, signal);
  });
});
