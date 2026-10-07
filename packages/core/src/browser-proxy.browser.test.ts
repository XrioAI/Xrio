import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { ChannelListener } from "node:diagnostics_channel";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { inspect } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { startDeadline } from "./deadline.ts";
import { isXrioError } from "./errors.ts";
import { readHostZone } from "./humanizer/host-zone.ts";
import { planIdentity } from "./humanizer/humanizer.ts";
import { resolveClientOptions } from "./options.ts";
import { startRelay } from "./proxy/relay.ts";
import {
  createScratchDir,
  prepareProfile,
  removeScratchDir,
} from "./sources/browser/browser-process.ts";
import { createCapabilityProbe } from "./sources/browser/capabilities.ts";
import { cdpDriver } from "./sources/browser/cdp/driver.ts";
import { killProcessGroup, waitForGroupExit } from "./sources/browser/group-lifetime.ts";
import { planLaunch } from "./sources/browser/launch-plan.ts";
import { CLOSE_BUDGET_MS } from "./sources/browser/port.ts";
import { renderDocument } from "./sources/browser/render.ts";
import { chromePath } from "./testing/chrome-path.ts";
import { fakeChromePath, pipeTeeChromePath } from "./testing/fake-chrome-path.ts";
import { startFakeHttpProxy, startFakeSocksProxy, TEST_ONLY_CERT } from "./testing/fake-proxies.ts";
import type { FakeProxy } from "./testing/fake-proxies.ts";
import { fixedDevice } from "./testing/fixed-seed.ts";
import { closedLoopbackPort, listenOnLoopback } from "./testing/fixture-server.ts";
import { noPins } from "./testing/no-pins.ts";
import { plannedScrapes } from "./testing/planned-scrapes.ts";
import type { PlannedScrapes } from "./testing/planned-scrapes.ts";
import { proxyObservation } from "./testing/proxy-observation.ts";
import type { ScrapeResult } from "./types.ts";

const RUNS_HEADLESS = process.env.XRIO_TEST_MODES?.split(",").includes("headless") ?? true;

const SCRAPE_TIMEOUT_MS = 20_000;

const SILENT_PROXY_TIMEOUT_MS = 8000;

const SLOW_CONNECT_MS = 1500;

const GROUP_EXIT_BUDGET_MS = 5000;

const TEST_ONLY_KEY = readFileSync(new URL("testing/test-only-key.pem", import.meta.url));

const TEST_CERT_SPKI = createHash("sha256")
  .update(new X509Certificate(TEST_ONLY_CERT).publicKey.export({ format: "der", type: "spki" }))
  .digest("base64");

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const WEBSOCKET_TEXT_FRAME = 0x81;

const WEBSOCKET_HEAD_BYTES = 2;

const FIXTURE_PAGE = "<!doctype html><title>fixture</title><p>served through the relay</p>";

const FIXTURE_HTML =
  "<!DOCTYPE html><html><head><title>fixture</title></head><body><p>served through the relay</p></body></html>";

const HALF_CLOSED_RESPONSE =
  "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!doctype html><title>half</title><p>closed by the target</p>";

const HALF_CLOSED_HTML =
  "<!DOCTYPE html><html><head><title>half</title></head><body><p>closed by the target</p></body></html>";

const WEBSOCKET_REPORT = /<p id="websocket">(?<message>[^<]*)<\/p>/u;

const WEBRTC_REPORT = /<pre id="webrtc">(?<report>[^<]*)<\/pre>/u;

const CANDIDATE_ADDRESS_FIELD = 4;

const RELAY_PROXY_SERVER = /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/u;

const WHITESPACE = /\s+/u;

const credentials = "user:s3cret";

const basic = (userinfo: string) => `Basic ${Buffer.from(userinfo).toString("base64")}`;

const withUserinfo = (url: string, userinfo: string) => url.replace("://", `://${userinfo}@`);

const runId = () => randomBytes(8).toString("hex");

const holdScript = (run: string) => `<script src="/hold.js?run=${run}"></script>`;

const websocketPage = (run: string) => `<!doctype html><title>websocket</title>
<p id="websocket">pending</p>
<script>
const scheme = location.protocol === "https:" ? "wss://" : "ws://";
const socket = new WebSocket(scheme + location.host + "/socket?run=${run}");
socket.onmessage = ({ data }) => {
  document.getElementById("websocket").textContent = "received " + data;
  socket.send("pong");
};
</script>
${holdScript(run)}`;

const webrtcPage = (run: string) => `<!doctype html><title>webrtc</title>
<pre id="webrtc">pending</pre>
<script>
const caller = new RTCPeerConnection({ iceServers: [] });
const callee = new RTCPeerConnection({ iceServers: [] });
const channel = caller.createDataChannel("probe");
const candidates = [];
const gathered = new Set();
let reported = false;
const iceStarted = () => caller.iceConnectionState !== "new" || callee.iceConnectionState !== "new";
const report = () => {
  if (reported) return;
  reported = true;
  document.getElementById("webrtc").textContent = JSON.stringify({ candidates, channel: channel.readyState });
  fetch("/release?run=${run}");
};
const relayCandidates = (from, to, name) => {
  from.onicecandidate = ({ candidate }) => {
    if (candidate) {
      candidates.push(candidate.candidate);
      to.addIceCandidate(candidate);
      return;
    }
    gathered.add(name);
    if (gathered.size === 2 && !iceStarted()) report();
  };
};
relayCandidates(caller, callee, "caller");
relayCandidates(callee, caller, "callee");
channel.onopen = report;
(async () => {
  await caller.setLocalDescription();
  await callee.setRemoteDescription(caller.localDescription);
  await callee.setLocalDescription();
  await caller.setRemoteDescription(callee.localDescription);
})();
</script>
${holdScript(run)}`;

interface Hold {
  readonly released: Promise<boolean>;
  readonly release: () => void;
}

const holds = new Map<string, Hold>();

const holdFor = (run: string): Hold => {
  const existing = holds.get(run);

  if (existing !== undefined) {
    return existing;
  }

  const { promise, resolve } = Promise.withResolvers<boolean>();

  const hold = {
    release: () => {
      resolve(true);
    },
    released: promise,
  };

  holds.set(run, hold);

  return hold;
};

const fixtureRequests: string[] = [];

const websocketFrames: { host: string | undefined; head: number[] }[] = [];

const sendHtml = (response: ServerResponse, html: string) => {
  response.writeHead(200, { "content-type": "text/html" }).end(html);
};

const serveFixture = (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://fixture.test");
  const run = url.searchParams.get("run") ?? "";

  fixtureRequests.push(`${request.method} ${request.headers.host}${url.pathname}${url.search}`);

  if (url.pathname === "/page") {
    sendHtml(response, FIXTURE_PAGE);
  } else if (url.pathname === "/redirect") {
    response.writeHead(302, { location: "https://other.test/page" }).end();
  } else if (url.pathname === "/websocket") {
    sendHtml(response, websocketPage(run));
  } else if (url.pathname === "/webrtc") {
    sendHtml(response, webrtcPage(run));
  } else if (url.pathname === "/release") {
    holdFor(run).release();
    response.writeHead(204).end();
  } else if (url.pathname === "/hold.js") {
    void holdFor(run).released.then(() => {
      response.writeHead(200, { "content-type": "text/javascript" }).end("");
    });
  } else {
    response.writeHead(404).end();
  }
};

const textFrame = (text: string): Buffer =>
  Buffer.concat([Buffer.from([WEBSOCKET_TEXT_FRAME, Buffer.byteLength(text)]), Buffer.from(text)]);

const readFrameHead = async (socket: Duplex): Promise<number[]> => {
  let received = Buffer.alloc(0);

  for await (const chunk of socket) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("The WebSocket client sent text instead of bytes.");
    }

    received = Buffer.concat([received, chunk]);

    if (received.byteLength >= WEBSOCKET_HEAD_BYTES) {
      return [...received.subarray(0, WEBSOCKET_HEAD_BYTES)];
    }
  }

  throw new Error("The WebSocket client closed before sending a frame.");
};

const answerWebSocket = async (request: IncomingMessage, socket: Duplex) => {
  const run = new URL(request.url ?? "/", "http://fixture.test").searchParams.get("run") ?? "";

  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}${WEBSOCKET_GUID}`)
    .digest("base64");

  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.write(textFrame("ping"));
  websocketFrames.push({ head: await readFrameHead(socket), host: request.headers.host });
  holdFor(run).release();
};

const trackedSockets = (server: Server): Set<Duplex> => {
  const sockets = new Set<Duplex>();

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  return sockets;
};

const closeServer = async (server: Server, sockets: Set<Duplex>) => {
  const closed = once(server, "close");

  for (const socket of sockets) {
    socket.destroy();
  }

  server.close();
  await closed;
};

const fixture = createServer(serveFixture);

const fixtureSockets = trackedSockets(fixture);

fixture.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
  answerWebSocket(request, socket).catch(() => {
    socket.destroy();
  });
});

const tlsFixture = createHttpsServer({ cert: TEST_ONLY_CERT, key: TEST_ONLY_KEY }, serveFixture);

const tlsFixtureSockets = trackedSockets(tlsFixture);

tlsFixture.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
  answerWebSocket(request, socket).catch(() => {
    socket.destroy();
  });
});

const halfClosingTarget = createTcpServer({ allowHalfOpen: true }, (socket) => {
  socket.once("data", () => {
    socket.end(HALF_CLOSED_RESPONSE);
  });
});

const halfClosingSockets = trackedSockets(halfClosingTarget);

let fixturePort: number;

let halfClosingPort: number;

let tlsFixturePort: number;

const proxyEndpointOf = (url: string) => {
  const { route } = resolveClientOptions({ mode: "http", proxy: url });

  if (route === undefined) {
    throw new Error("Expected a proxy endpoint.");
  }

  return route;
};

let client: PlannedScrapes | undefined;

// These transport tests fix metadata; coordinator and public-client tests cover lookup failures.
const testProxyInfo = async () => await Promise.resolve(proxyObservation);

const scrape = async (url: string, proxy?: string, timeoutMs = SCRAPE_TIMEOUT_MS) => {
  client ??= plannedScrapes(cdpDriver, 1, { proxyInfo: testProxyInfo });
  using deadline = startDeadline(timeoutMs);

  const document = await client.capture({
    browserArgs: [],
    browserPath: chromePath(),
    deadline,
    mode: "headless",
    pins: noPins,
    proxy: proxy === undefined ? undefined : proxyEndpointOf(proxy),
    url: new URL(url),
  });

  return { ...document, data: document.html, format: "html" as const };
};

const rejectionOf = async (pending: Promise<unknown>) => {
  try {
    await pending;
  } catch (error) {
    return error;
  }

  throw new Error("Expected the scrape to fail.");
};

const failureOf = async (url: string, proxy: string, timeoutMs = SCRAPE_TIMEOUT_MS) =>
  await rejectionOf(scrape(url, proxy, timeoutMs));

const leaksOf = ({ identity }: ScrapeResult) => {
  if (identity.mode === "http") {
    throw new Error("A browser scrape reports a browser identity.");
  }

  return [identity.exit.route, identity.surfaces.leaks.webrtc];
};

const requestsFor = (proxy: FakeProxy, host: string) =>
  proxy.requests.filter(({ authority }) => authority.includes(host));

const authorizationsSeenBy = (proxy: FakeProxy) =>
  new Set(proxy.requests.map(({ authorization }) => authorization));

const isText = (value: unknown): value is string => typeof value === "string";

interface WebrtcReport {
  readonly candidates: readonly string[];
  readonly channel: string;
}

const isWebrtcReport = (value: unknown): value is WebrtcReport =>
  typeof value === "object" &&
  value !== null &&
  "candidates" in value &&
  Array.isArray(value.candidates) &&
  value.candidates.every(isText) &&
  "channel" in value &&
  isText(value.channel);

const webrtcReportOf = (html: string): WebrtcReport => {
  const report: unknown = JSON.parse(WEBRTC_REPORT.exec(html)?.groups?.report ?? "null");

  if (!isWebrtcReport(report)) {
    throw new Error("The page did not write its WebRTC report.");
  }

  return report;
};

const candidateAddressOf = (candidate: string) =>
  candidate.trim().split(WHITESPACE)[CANDIDATE_ADDRESS_FIELD];

const isArgvEvent = (value: unknown): value is { event: "browser-argv"; detail: string } =>
  typeof value === "object" &&
  value !== null &&
  "event" in value &&
  value.event === "browser-argv" &&
  "detail" in value &&
  isText(value.detail);

const proxyServerOf = ({ detail }: { detail: string }): string[] => {
  const argv: unknown = JSON.parse(detail);

  return Array.isArray(argv)
    ? argv.filter(isText).filter((arg) => arg.startsWith("--proxy-server="))
    : [];
};

const serveFixtures = () => {
  beforeAll(async () => {
    fixturePort = await listenOnLoopback(fixture);
    halfClosingPort = await listenOnLoopback(halfClosingTarget);
    tlsFixturePort = await listenOnLoopback(tlsFixture);
  });

  afterAll(async () => {
    await client?.close();
    client = undefined;
    await closeServer(fixture, fixtureSockets);
    await closeServer(halfClosingTarget, halfClosingSockets);
    await closeServer(tlsFixture, tlsFixtureSockets);
  });
};

interface PipeFrame {
  readonly direction: "to-chrome" | "from-chrome";
  readonly frame: string;
}

const isPipeFrame = (value: unknown): value is PipeFrame =>
  typeof value === "object" &&
  value !== null &&
  "direction" in value &&
  (value.direction === "to-chrome" || value.direction === "from-chrome") &&
  "frame" in value &&
  isText(value.frame);

const pipeFramesIn = async (log: string): Promise<PipeFrame[]> => {
  const contents = await readFile(log, "utf-8");

  return contents.split("\n").flatMap((line) => {
    const frame: unknown = line === "" ? undefined : JSON.parse(line);

    return isPipeFrame(frame) ? [frame] : [];
  });
};

interface NavigateCommand {
  readonly method: "Page.navigate";
  readonly params: object;
}

const isNavigateCommand = (value: unknown): value is NavigateCommand =>
  typeof value === "object" &&
  value !== null &&
  "method" in value &&
  value.method === "Page.navigate" &&
  "params" in value &&
  typeof value.params === "object" &&
  value.params !== null;

const navigationParamsOf = (frames: readonly PipeFrame[]): object[] =>
  frames.flatMap(({ direction, frame }) => {
    const command: unknown = direction === "to-chrome" ? JSON.parse(frame) : undefined;

    return isNavigateCommand(command) ? [command.params] : [];
  });

const renderThroughRelay = async (proxy: string, url: string) => {
  using deadline = startDeadline(SCRAPE_TIMEOUT_MS);
  await using relay = await startRelay(proxyEndpointOf(proxy), deadline, "loopback");
  const teeDirectory = await mkdtemp(path.join(tmpdir(), "xrio-pipe-tee-"));
  const tee = await pipeTeeChromePath(chromePath(), teeDirectory);
  const scratch = await createScratchDir(Date.now());

  const plan = planLaunch({
    browserArgs: [`--ignore-certificate-errors-spki-list=${TEST_CERT_SPKI}`],
    browserPath: tee.executable,
    display: undefined,
    headless: true,
    identity: planIdentity({
      capabilities: await createCapabilityProbe()(chromePath()),
      device: fixedDevice,
      exit: { facts: { kind: "unknown" }, route: "proxy" },
      hostZone: readHostZone(),
      mode: "headless",
      pins: noPins,
    }).inputs,
    proxyServer: relay.url,
    scratchDir: scratch.path,
    xauthority: undefined,
  });

  await prepareProfile(plan);
  let pid: number | undefined;

  const browser = await cdpDriver.launch(
    plan,
    deadline,
    (reported) => {
      pid = reported;
    },
    () => {},
  );

  try {
    const { source } = await renderDocument(
      browser,
      new URL(url),
      relay,
      deadline,
      async () => await Promise.resolve(null),
    );

    return { frames: await pipeFramesIn(tee.log), source };
  } finally {
    await browser.close(CLOSE_BUDGET_MS);

    if (pid !== undefined) {
      killProcessGroup(pid);
      await waitForGroupExit(pid, AbortSignal.timeout(GROUP_EXIT_BUDGET_MS));
    }

    await removeScratchDir(scratch);
    await rm(teeDirectory, { force: true, recursive: true });
  }
};

describe.runIf(RUNS_HEADLESS)("a headless scrape through a proxy returns the page", () => {
  serveFixtures();

  it("through an HTTP proxy, which receives the relay's credentials", async () => {
    await using proxy = await startFakeHttpProxy({
      requireCredentials: credentials,
      tunnelTo: fixturePort,
    });

    const result = await scrape("http://fixture.test/page", withUserinfo(proxy.url, credentials));

    expect([result.status, result.url, result.data]).toStrictEqual([
      200,
      "http://fixture.test/page",
      FIXTURE_HTML,
    ]);
    expect(requestsFor(proxy, "fixture.test/page")).toStrictEqual([
      { authority: "http://fixture.test/page", authorization: basic(credentials) },
    ]);
    expect(authorizationsSeenBy(proxy)).toStrictEqual(new Set([basic(credentials)]));
    expect(leaksOf(result)).toStrictEqual(["proxy", "disable_non_proxied_udp"]);
    expect(result.identity).toMatchObject({
      observed: { languages: ["de-DE", "de", "en-US", "en"], timeZone: "Europe/Berlin" },
      surfaces: { timezone: { source: "exit", zone: "Europe/Berlin" } },
    });
  });

  it("through a SOCKS5 proxy, which receives the relay's credentials and the target's name", async () => {
    await using proxy = await startFakeSocksProxy({
      requireCredentials: credentials,
      tunnelTo: fixturePort,
    });

    const result = await scrape("http://fixture.test/page", withUserinfo(proxy.url, credentials));

    expect([result.status, result.data]).toStrictEqual([200, FIXTURE_HTML]);
    expect(requestsFor(proxy, "fixture.test")).toContainEqual({
      authority: "fixture.test",
      authorization: credentials,
    });
    expect(authorizationsSeenBy(proxy)).toStrictEqual(new Set([credentials]));
    expect(leaksOf(result)).toStrictEqual(["proxy", "disable_non_proxied_udp"]);
  });

  it("when the SOCKS5 proxy answers CONNECT late but inside the deadline", async () => {
    await using proxy = await startFakeSocksProxy({
      connectDelayMs: SLOW_CONNECT_MS,
      tunnelTo: fixturePort,
    });

    const result = await scrape("http://fixture.test/page", proxy.url);

    expect([result.status, result.data]).toStrictEqual([200, FIXTURE_HTML]);
  });

  it.each([
    { kind: "HTTP", start: startFakeHttpProxy },
    { kind: "SOCKS5", start: startFakeSocksProxy },
  ])("whole when the target half-closes after its response, through $kind", async ({ start }) => {
    await using proxy = await start({ tunnelTo: halfClosingPort });

    const result = await scrape("http://half.test/", proxy.url);

    expect([result.status, result.data]).toStrictEqual([200, HALF_CLOSED_HTML]);
  });

  it("after its WebSocket exchanged a message through the proxy, tunnelled by name", async () => {
    await using proxy = await startFakeHttpProxy({ tunnelTo: fixturePort });

    const result = await scrape(`http://fixture.test/websocket?run=${runId()}`, proxy.url);

    expect(WEBSOCKET_REPORT.exec(result.data)?.groups?.message).toBe("received ping");
    expect(requestsFor(proxy, "fixture.test:80")).toStrictEqual([
      { authority: "fixture.test:80", authorization: undefined },
    ]);
    expect(websocketFrames.at(-1)).toStrictEqual({ head: [129, 132], host: "fixture.test" });
  });

  it("with no WebRTC candidate and no open data channel through a proxy", async () => {
    await using proxy = await startFakeHttpProxy({ tunnelTo: fixturePort });

    const result = await scrape(`http://fixture.test/webrtc?run=${runId()}`, proxy.url);

    expect(webrtcReportOf(result.data)).toStrictEqual({ candidates: [], channel: "connecting" });
  });

  it("with .local host candidates and an open data channel on a direct scrape", async () => {
    const result = await scrape(`http://127.0.0.1:${fixturePort}/webrtc?run=${runId()}`);
    const { candidates, channel } = webrtcReportOf(result.data);
    const addresses = candidates.map(candidateAddressOf);

    expect(channel).toBe("open");
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.filter((address) => !address?.endsWith(".local"))).toStrictEqual([]);
  });
});

describe.runIf(RUNS_HEADLESS)("a headless scrape through a proxy reports the relay's code", () => {
  serveFixtures();

  it.each(["http://fixture.test/page", "https://fixture.test/page"])(
    "PROXY_AUTH_FAILED when the HTTP proxy answers 407 for %s",
    async (url) => {
      await using proxy = await startFakeHttpProxy({
        requireCredentials: credentials,
        tunnelTo: fixturePort,
      });

      await expect(failureOf(url, withUserinfo(proxy.url, "user:wrong"))).resolves.toMatchObject({
        code: "PROXY_AUTH_FAILED",
        message: `The proxy ${proxy.url}/ rejected its credentials.`,
      });
    },
  );

  it("PROXY_AUTH_FAILED when the SOCKS5 proxy rejects the credentials", async () => {
    await using proxy = await startFakeSocksProxy({
      requireCredentials: credentials,
      tunnelTo: fixturePort,
    });

    await expect(
      failureOf("http://fixture.test/page", withUserinfo(proxy.url, "user:wrong")),
    ).resolves.toMatchObject({ code: "PROXY_AUTH_FAILED" });
  });

  it("PROXY_UNREACHABLE when nothing listens at the proxy's port", async () => {
    const proxy = `http://127.0.0.1:${await closedLoopbackPort()}`;

    await expect(failureOf("https://fixture.test/page", proxy)).resolves.toMatchObject({
      code: "PROXY_UNREACHABLE",
      message: `Could not connect to the proxy ${proxy}/.`,
    });
  });

  it("NETWORK_ERROR when the proxy answers 502 to CONNECT", async () => {
    await using proxy = await startFakeHttpProxy({ connectStatus: 502, tunnelTo: fixturePort });

    await expect(failureOf("https://fixture.test/page", proxy.url)).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      message: `The proxy ${proxy.url}/ could not reach fixture.test:443 (502).`,
    });
  });

  it("PROXY_CONNECT_FAILED with the status when the proxy answers 403 to CONNECT", async () => {
    await using proxy = await startFakeHttpProxy({ connectStatus: 403, tunnelTo: fixturePort });

    await expect(failureOf("https://fixture.test/page", proxy.url)).resolves.toMatchObject({
      code: "PROXY_CONNECT_FAILED",
      details: { status: 403 },
    });
  });

  it("PROXY_CONNECT_FAILED for the redirect hop whose CONNECT the proxy refused", async () => {
    await using proxy = await startFakeHttpProxy({ connectStatus: 403, tunnelTo: fixturePort });

    await expect(failureOf("http://fixture.test/redirect", proxy.url)).resolves.toMatchObject({
      code: "PROXY_CONNECT_FAILED",
      details: { status: 403 },
      message: `The proxy ${proxy.url}/ refused a tunnel to other.test:443 (403).`,
    });
    expect(
      proxy.requests.filter(
        ({ authority }) => authority.includes(".test/") || authority.startsWith("other.test"),
      ),
    ).toStrictEqual([
      { authority: "http://fixture.test/redirect", authorization: undefined },
      { authority: "other.test:443", authorization: undefined },
    ]);
  });

  it("TIMEOUT when the proxy never answers CONNECT", async () => {
    await using proxy = await startFakeHttpProxy({ silent: true, tunnelTo: fixturePort });

    await expect(
      failureOf("https://fixture.test/page", proxy.url, SILENT_PROXY_TIMEOUT_MS),
    ).resolves.toMatchObject({ code: "TIMEOUT" });
  });

  it("NETWORK_ERROR for a loopback target, which never sees the request", async () => {
    await using proxy = await startFakeHttpProxy({ tunnelTo: fixturePort });
    const target = `/page?run=${runId()}`;

    await expect(
      failureOf(`http://127.0.0.1:${fixturePort}${target}`, proxy.url),
    ).resolves.toMatchObject({
      code: "NETWORK_ERROR",
      message: `Refused to send the local address 127.0.0.1 through the proxy ${proxy.url}/.`,
    });
    expect(fixtureRequests.filter((request) => request.endsWith(target))).toStrictEqual([]);
  });
});

describe.runIf(RUNS_HEADLESS)(
  "a headless browser one layer down, trusting the test certificate, through the relay",
  () => {
    serveFixtures();

    it("carries a wss:// WebSocket through the proxy with the relay's credentials", async () => {
      await using proxy = await startFakeHttpProxy({
        requireCredentials: credentials,
        tunnelTo: tlsFixturePort,
      });

      const { source } = await renderThroughRelay(
        withUserinfo(proxy.url, credentials),
        `https://fixture.test/websocket?run=${runId()}`,
      );

      expect([source.status, WEBSOCKET_REPORT.exec(source.html)?.groups?.message]).toStrictEqual([
        200,
        "received ping",
      ]);
      expect(
        new Set(requestsFor(proxy, "fixture.test").map((entry) => JSON.stringify(entry))),
      ).toStrictEqual(
        new Set([
          JSON.stringify({ authority: "fixture.test:443", authorization: basic(credentials) }),
        ]),
      );
      expect(websocketFrames.at(-1)).toStrictEqual({ head: [129, 132], host: "fixture.test" });
    });

    it("returns an https:// page when the HTTP proxy answers CONNECT late but inside the deadline", async () => {
      await using proxy = await startFakeHttpProxy({
        connectDelayMs: SLOW_CONNECT_MS,
        tunnelTo: tlsFixturePort,
      });

      const { source } = await renderThroughRelay(proxy.url, "https://fixture.test/page");

      expect([source.status, source.html]).toStrictEqual([200, FIXTURE_HTML]);
    });

    it("writes no proxy username or password to Chrome's pipe, and navigates by the target URL alone", async () => {
      const username = `proxy-user-${runId()}`;
      const password = `s3cret-${runId()}`;

      await using proxy = await startFakeHttpProxy({
        requireCredentials: `${username}:${password}`,
        tunnelTo: tlsFixturePort,
      });

      const { frames, source } = await renderThroughRelay(
        withUserinfo(proxy.url, `${username}:${password}`),
        "https://fixture.test/page",
      );

      expect([source.status, new Set(frames.map(({ direction }) => direction))]).toStrictEqual([
        200,
        new Set(["to-chrome", "from-chrome"]),
      ]);
      expect(
        frames.filter(({ frame }) => frame.includes(username) || frame.includes(password)),
      ).toStrictEqual([]);
      expect(navigationParamsOf(frames)).toStrictEqual([{ url: "https://fixture.test/page" }]);
    });
  },
);

describe.runIf(RUNS_HEADLESS)("the proxy password", () => {
  serveFixtures();

  it("never shows in diagnostics events, CDP commands, results or failures", async () => {
    const password = `s3cret-${runId()}`;
    const observed: unknown[] = [];

    const record: ChannelListener = (message) => {
      observed.push(message);
    };

    await using httpProxy = await startFakeHttpProxy({
      requireCredentials: `user:${password}`,
      tunnelTo: fixturePort,
    });

    await using socksProxy = await startFakeSocksProxy({
      requireCredentials: "user:another",
      tunnelTo: fixturePort,
    });

    subscribe("xrio:event", record);
    subscribe("xrio:cdp-command", record);

    try {
      observed.push(
        await scrape("http://fixture.test/page", withUserinfo(httpProxy.url, `user:${password}`)),
        await failureOf(
          "http://fixture.test/page",
          withUserinfo(socksProxy.url, `user:${password}`),
        ),
      );
    } finally {
      unsubscribe("xrio:event", record);
      unsubscribe("xrio:cdp-command", record);
    }

    const proxyServers = observed.filter(isArgvEvent).flatMap(proxyServerOf);

    expect(observed).toContainEqual(expect.objectContaining({ event: "identity-chosen" }));
    expect(observed).toContainEqual({ method: "Page.navigate", scope: "main" });
    expect(observed.at(-1)).toMatchObject({ code: "PROXY_AUTH_FAILED" });
    expect(
      observed.filter((value) => inspect(value, { depth: Infinity }).includes(password)),
    ).toStrictEqual([]);
    expect(proxyServers.map((arg) => RELAY_PROXY_SERVER.test(arg))).toStrictEqual([true, true]);
  });

  it("never shows in a launch failure whose stderr tail holds Chrome's whole argv", async () => {
    const password = `s3cret-${runId()}`;

    const failing = plannedScrapes(cdpDriver, 1, { proxyInfo: testProxyInfo });
    using deadline = startDeadline(SCRAPE_TIMEOUT_MS);

    const failure = await rejectionOf(
      failing.capture({
        browserArgs: [],
        browserPath: await fakeChromePath("argv-on-stderr"),
        deadline,
        mode: "headless",
        pins: noPins,
        proxy: proxyEndpointOf(`http://user:${password}@127.0.0.1:${await closedLoopbackPort()}`),
        url: new URL("http://fixture.test/page"),
      }),
    );

    await failing.close();

    if (!isXrioError(failure, "BROWSER_LAUNCH_FAILED")) {
      throw failure;
    }

    const proxyServers = failure.details.stderr
      .split("\n")
      .filter((line) => line.startsWith("--proxy-server="));

    expect(proxyServers.map((arg) => RELAY_PROXY_SERVER.test(arg))).toStrictEqual([true]);
    expect(inspect(failure, { depth: Infinity })).not.toContain(password);
  });
});
