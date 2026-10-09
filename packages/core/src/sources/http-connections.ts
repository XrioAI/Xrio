import { createHash } from "node:crypto";

import { createSession, createTransport } from "wreq-js";
import type { CreateTransportOptions, Session, Transport } from "wreq-js";

import type { Clock, Deadline } from "../deadline.ts";
import { publishInternalEvent } from "../diagnostics.ts";
import { startRelay } from "../proxy/relay.ts";
import type { Relay } from "../proxy/relay.ts";
import type { ProxyEndpoint } from "../types.ts";
import type { VisitPlan } from "./visit.ts";

const IDLE_MS = 30_000;

const MAX_IDLE_LANES_PER_ROUTE = 6;

export type ConnectionProfile = Required<
  Pick<CreateTransportOptions, "browser" | "emulation" | "os">
> & {
  readonly defaultHeaders: Readonly<Record<string, string>>;
};

export interface Lane extends AsyncDisposable {
  readonly transport: Transport;
  readonly failureFor: Relay["failureFor"];
  readonly startSession: (defaultHeaders: ConnectionProfile["defaultHeaders"]) => Promise<Session>;
  readonly keep: () => void;
}

type HttpRoute = Pick<Extract<VisitPlan, { kind: "http" }>, "pinnedExit" | "proxy">;

export interface HttpConnections {
  readonly lend: (
    route: HttpRoute,
    profile: ConnectionProfile,
    deadline: Deadline,
  ) => Promise<Lane>;
  readonly close: () => Promise<void>;
}

interface KeptLane {
  readonly key: string;
  readonly relay: Relay;
  readonly transport: Transport;
}

const laneKey = (proxy: ProxyEndpoint | undefined, profile: ConnectionProfile): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        proxy === undefined
          ? null
          : [proxy.protocol, proxy.hostname, proxy.port, proxy.credentials ?? null],
        profile,
      ]),
    )
    .digest("hex");

const openLane = async (
  key: string,
  proxy: ProxyEndpoint | undefined,
  { browser, emulation, os }: ConnectionProfile,
  deadline: Deadline,
): Promise<KeptLane> => {
  const relay = await startRelay(proxy, deadline, "token");

  try {
    const transport = await createTransport({
      browser,
      emulation,
      os,
      poolIdleTimeout: IDLE_MS,
      proxy: relay.url,
    });

    return { key, relay, transport };
  } catch (error) {
    await relay[Symbol.asyncDispose]();
    throw error;
  }
};

const closeLane = async ({ relay, transport }: KeptLane): Promise<void> => {
  try {
    await transport.close();
  } finally {
    await relay[Symbol.asyncDispose]();
  }
};

const closeQuietly = async (lane: KeptLane): Promise<void> => {
  try {
    await closeLane(lane);
  } catch (error) {
    publishInternalEvent({
      detail: `Closing an http connection failed: ${error instanceof Error ? error.message : String(error)}`,
      event: "teardown-incomplete",
    });
  }
};

const idleTimer: Clock["setTimer"] = (delayMs, onTimeout) => {
  const timer = setTimeout(onTimeout, delayMs).unref();

  return () => {
    clearTimeout(timer);
  };
};

export const createHttpConnections = (setTimer: Clock["setTimer"] = idleTimer): HttpConnections => {
  const open = new Set<KeptLane>();
  const idle = new Map<KeptLane, () => void>();
  const retiring = new Set<Promise<void>>();
  let closed = false;

  const retire = async (lane: KeptLane) => {
    if (!open.delete(lane)) {
      return;
    }

    const retirement = closeQuietly(lane);

    retiring.add(retirement);
    await retirement;
    retiring.delete(retirement);
  };

  const keepIdle = (lane: KeptLane) => {
    lane.relay.rest();
    idle.set(
      lane,
      setTimer(IDLE_MS, () => {
        idle.delete(lane);
        void retire(lane);
      }),
    );
  };

  const reuse = (key: string, deadline: Deadline): KeptLane | undefined => {
    const lane = [...idle.keys()].findLast((candidate) => candidate.key === key);

    if (lane !== undefined) {
      idle.get(lane)?.();
      idle.delete(lane);
      lane.relay.lendTo(deadline);
    }

    return lane;
  };

  const idleLanesFor = (key: string) =>
    [...idle.keys()].filter((candidate) => candidate.key === key).length;

  const release = async (lane: KeptLane, pinnedExit: boolean) => {
    if (pinnedExit && !closed && idleLanesFor(lane.key) < MAX_IDLE_LANES_PER_ROUTE) {
      keepIdle(lane);

      return;
    }

    await retire(lane);
  };

  const lend: HttpConnections["lend"] = async ({ pinnedExit, proxy }, profile, deadline) => {
    const key = laneKey(proxy, profile);
    const reused = pinnedExit ? reuse(key, deadline) : undefined;
    const lane = reused ?? (await openLane(key, proxy, profile, deadline));

    open.add(lane);
    let succeeded = false;

    return {
      [Symbol.asyncDispose]: async () => {
        await release(lane, pinnedExit && succeeded);
      },
      failureFor: (hostname) => lane.relay.failureFor(hostname),
      keep: () => {
        succeeded = true;
      },
      startSession: async (defaultHeaders) =>
        await createSession({ defaultHeaders, proxy: lane.relay.url, timeout: 0 }),
      transport: lane.transport,
    };
  };

  const close = async () => {
    closed = true;

    for (const stopIdleTimer of idle.values()) {
      stopIdleTimer();
    }

    idle.clear();
    const closing = [...open].map(retire);

    await Promise.all([...closing, ...retiring]);
  };

  return { close, lend };
};
