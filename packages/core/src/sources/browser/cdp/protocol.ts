import type { Protocol } from "devtools-protocol";
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping.js";

export type TargetScope =
  | "main"
  | "popup"
  | "iframe"
  | "worker"
  | "service_worker"
  | "shared_worker"
  | "other";

export type Scope = "browser" | TargetScope;

export interface BrowserSession {
  readonly scope: "browser";
}

export interface TargetSession<Kind extends TargetScope = TargetScope> {
  readonly scope: Kind;
  readonly id: string;
  readonly targetId: string;
}

export type AnyTargetSession = { [Kind in TargetScope]: TargetSession<Kind> }[TargetScope];

type Session = BrowserSession | AnyTargetSession;

export const BROWSER: BrowserSession = { scope: "browser" };

const CHILD_HOSTS = ["main", "popup", "iframe", "worker"] as const satisfies readonly TargetScope[];

const EVERY_TARGET = [
  ...CHILD_HOSTS,
  "service_worker",
  "shared_worker",
  "other",
] as const satisfies readonly TargetScope[];

const ALLOWED_COMMANDS = {
  "Browser.close": ["browser"],
  "Browser.getVersion": ["browser"],
  "Browser.setDownloadBehavior": ["browser"],
  "Network.enable": EVERY_TARGET,
  "Network.getResponseBody": ["main"],
  "Page.bringToFront": ["main"],
  "Page.createIsolatedWorld": ["main"],
  "Page.enable": ["main"],
  "Page.handleJavaScriptDialog": ["main"],
  "Page.navigate": ["main"],
  "Page.setLifecycleEventsEnabled": ["main"],
  "Runtime.evaluate": ["main"],
  "Runtime.runIfWaitingForDebugger": EVERY_TARGET,
  "Target.setAutoAttach": ["browser", ...CHILD_HOSTS],
} as const satisfies Partial<Record<keyof ProtocolMapping.Commands, readonly Scope[]>>;

export type Method = keyof typeof ALLOWED_COMMANDS;

type ScopeOf<Name extends Method> = (typeof ALLOWED_COMMANDS)[Name][number];

type ChildHost = (typeof CHILD_HOSTS)[number];

export const hostsChildren = (session: AnyTargetSession): session is TargetSession<ChildHost> =>
  CHILD_HOSTS.some((scope) => scope === session.scope);

type ProtocolParams<Name extends Method> = ProtocolMapping.Commands[Name]["paramsType"] extends []
  ? NoParams
  : NonNullable<ProtocolMapping.Commands[Name]["paramsType"][0]>;

type NoParams = Readonly<Record<string, never>>;

declare const isolated: unique symbol;

export type IsolatedContextId = Protocol.Runtime.ExecutionContextId & { readonly [isolated]: true };

interface AutoAttach {
  readonly autoAttach: true;
  readonly waitForDebuggerOnStart: true;
  readonly flatten: true;
}

interface PagesOnly extends AutoAttach {
  readonly filter: [{ readonly type: "page" }];
}

interface EveryChild extends AutoAttach {
  readonly filter?: never;
}

interface PreviewBuffers {
  readonly maxResourceBufferSize: 65_536;
  readonly maxTotalBufferSize: 1_048_576;
}

interface NoBodyBuffers {
  readonly maxResourceBufferSize: 0;
  readonly maxTotalBufferSize: 0;
}

type Narrowed<Table extends { [Name in Method]: ProtocolParams<Name> }> = Table;

type ParamsIn<Kind extends Scope> = Narrowed<{
  "Browser.close": NoParams;
  "Browser.getVersion": NoParams;
  "Browser.setDownloadBehavior": { readonly behavior: "deny" };
  "Network.enable": Kind extends "main" ? PreviewBuffers : NoBodyBuffers;
  "Network.getResponseBody": { readonly requestId: string };
  "Page.bringToFront": NoParams;
  "Page.createIsolatedWorld": { readonly frameId: string; readonly worldName: "" };
  "Page.enable": NoParams;
  "Page.handleJavaScriptDialog": { readonly accept: false };
  "Page.navigate": { readonly url: string };
  "Page.setLifecycleEventsEnabled": { readonly enabled: true };
  "Runtime.evaluate": {
    readonly awaitPromise: true;
    readonly contextId: IsolatedContextId;
    readonly expression: string;
    readonly returnByValue: true;
  };
  "Runtime.runIfWaitingForDebugger": NoParams;
  "Target.setAutoAttach": Kind extends "browser" ? PagesOnly : EveryChild;
}>;

export type ParamsOf<Name extends Method, Kind extends Scope> = ParamsIn<Kind>[Name];

export type ResultOf<Name extends Method> = Name extends "Page.createIsolatedWorld"
  ? { readonly executionContextId: IsolatedContextId }
  : ProtocolMapping.Commands[Name]["returnType"];

export type Send = <Name extends Method, Kind extends ScopeOf<Name>>(
  session: Session & { readonly scope: Kind },
  method: Name,
  params: ParamsOf<Name, Kind>,
  signal: AbortSignal,
) => Promise<ResultOf<Name>>;

export const CONSUMED_EVENTS = [
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.responseReceivedExtraInfo",
  "Page.downloadProgress",
  "Page.downloadWillBegin",
  "Page.frameNavigated",
  "Page.javascriptDialogOpening",
  "Page.lifecycleEvent",
] as const satisfies readonly (keyof ProtocolMapping.Events)[];

export type ConsumedMethod = (typeof CONSUMED_EVENTS)[number];

export type DomainEvent = {
  [Name in ConsumedMethod]: {
    readonly method: Name;
    readonly params: ProtocolMapping.Events[Name][0];
  };
}[ConsumedMethod];
