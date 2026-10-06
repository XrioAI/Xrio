import type { IncomingMessage, ServerResponse } from "node:http";

import { afterCaptureRead } from "../humanizer/verify.ts";
import { closedLoopbackPort } from "./fixture-server.ts";
import type { FixtureHandler, FixtureOrigins } from "./fixture-server.ts";

const HUGE_DOM_ELEMENTS = 200_000;

const SLICED_FILLER_CODE_UNITS = 4 * 1024 * 1024;

const OVERSIZED_FILLER_CODE_UNITS = 33 * 1024 * 1024;

const WINDOW_SIZE_POLL_MS = 10;

const MEDIA_REQUEST_WAIT_MS = 1500;

const WINDOW_SIZE_GIVE_UP_MS = 5000;

const CONFORMANCE_PAGE_GIVE_UP_MS = 5000;

const REALM_COUNT = 8;

const CYRILLIC_WINDOWS_1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);

const PROBE_SCRIPT = `<script>
document.addEventListener("DOMContentLoaded", () => {
  const probe = document.createElement("output");
  probe.id = "probe";
  probe.dataset.webdriver = String(navigator.webdriver);
  probe.dataset.focus = String(document.hasFocus());
  probe.dataset.visibility = document.visibilityState;
  document.body.append(probe);
});
</script>`;

const WINDOW_SIZE_WATCH = `<script>
(() => {
  const started = performance.now();
  const watch = () => {
    const sized = window.outerWidth > 0;
    if (sized || performance.now() - started > ${WINDOW_SIZE_GIVE_UP_MS}) {
      window.identitySizeWait = sized ? "settled" : "gave-up";
      fetch("/identity-sized");
    } else {
      setTimeout(watch, ${WINDOW_SIZE_POLL_MS});
    }
  };
  watch();
})();
</script>`;

const REALM_ROW_SOURCE = `const realmRow = () => ({
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory ?? null,
  cpuPerformance: navigator.cpuPerformance ?? null,
  jsHeapSizeLimit: performance.memory?.jsHeapSizeLimit ?? null,
  userAgent: navigator.userAgent,
  languages: [...navigator.languages],
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});`;

const START_REALMS_SOURCE = `${REALM_ROW_SOURCE}

const startServiceWorker = (publish) => {
  navigator.serviceWorker.addEventListener("message", (event) => {
    publish("service", event.data);
  });
  navigator.serviceWorker
    .register("/identity-realm.js")
    .then(async () => {
      (await navigator.serviceWorker.ready).active.postMessage("report");
    })
    .catch((error) => {
      publish("service", { error: String(error) });
    });
};

const startRealms = (publish, { withServiceWorker }) => {
  publish("window", realmRow());
  new Worker("/identity-realm.js").addEventListener("message", (event) => {
    publish("dedicated", event.data);
  });
  const shared = new SharedWorker("/identity-realm.js");
  shared.port.addEventListener("message", (event) => {
    publish("shared", event.data);
  });
  shared.port.start();
  if (withServiceWorker) {
    startServiceWorker(publish);
  }
};`;

const identityReportScript = (crossOrigin: string): string => `<script>
${START_REALMS_SOURCE}
(() => {
  const offsetIn = (month) => -new Date(new Date().getFullYear(), month, 15).getTimezoneOffset();
  const gl = document.createElement("canvas").getContext("webgl");
  const debug = gl?.getExtension("WEBGL_debug_renderer_info");
  const glString = (unmasked, masked) => gl?.getParameter(debug ? unmasked : masked) ?? null;
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const screenFields = [
    "width", "height", "availWidth", "availHeight", "availLeft", "availTop", "colorDepth", "pixelDepth",
  ];
  const report = {
    timeZone: resolved.timeZone,
    offsets: { january: offsetIn(0), july: offsetIn(6) },
    intlLocale: resolved.locale,
    language: navigator.language,
    languages: [...navigator.languages],
    screen: {
      ...Object.fromEntries(screenFields.map((field) => [field, screen[field]])),
      orientation: { angle: screen.orientation.angle, type: screen.orientation.type },
      isExtended: screen.isExtended ?? null,
      devicePixelRatio: window.devicePixelRatio,
    },
    window: {
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
    },
    windowSizeWait: window.identitySizeWait,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    cpuPerformance: navigator.cpuPerformance ?? null,
    jsHeapSizeLimit: performance.memory?.jsHeapSizeLimit ?? null,
    userAgentData: { platform: navigator.userAgentData?.platform ?? null },
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    webgl: {
      vendor: glString(debug?.UNMASKED_VENDOR_WEBGL, gl?.VENDOR),
      renderer: glString(debug?.UNMASKED_RENDERER_WEBGL, gl?.RENDERER),
      extensions: gl?.getSupportedExtensions() ?? null,
    },
  };
  document.getElementById("identity").textContent = JSON.stringify(report);

  const realms = { frame: {} };
  const reported = () => Object.keys(realms).length - 1 + Object.keys(realms.frame).length;
  const publish = (inFrame, name, row) => {
    (inFrame ? realms.frame : realms)[name] = row;
    document.getElementById("identity-workers").textContent = JSON.stringify(realms);
    if (reported() === ${REALM_COUNT}) {
      fetch("/identity-realms-done");
    }
  };
  setTimeout(() => fetch("/identity-realms-done"), ${CONFORMANCE_PAGE_GIVE_UP_MS});

  const crossSiteFrame = document.createElement("iframe");
  const serviceFrame = document.createElement("iframe");
  addEventListener("message", (event) => {
    if (event.source === crossSiteFrame.contentWindow) {
      publish(true, event.data.name, event.data.row);
    } else if (event.source === serviceFrame.contentWindow) {
      publish(false, event.data.name, event.data.row);
    }
  });
  crossSiteFrame.src = ${JSON.stringify(`${crossOrigin}/identity-frame`)};
  serviceFrame.src = "/identity-service-frame";
  document.body.append(crossSiteFrame, serviceFrame);

  startRealms((name, row) => publish(false, name, row), { withServiceWorker: false });
})();
</script>`;

const IDENTITY_FRAME_SCRIPT = `<script>
${START_REALMS_SOURCE}
startRealms((name, row) => parent.postMessage({ name, row }, "*"), { withServiceWorker: true });
</script>`;

const IDENTITY_SERVICE_FRAME_SCRIPT = `<script>
${START_REALMS_SOURCE}
startServiceWorker((name, row) => parent.postMessage({ name, row }, "*"));
</script>`;

const CLIENT_HINTS_SCRIPT = `<script>
setTimeout(() => fetch("/client-hints-done"), ${CONFORMANCE_PAGE_GIVE_UP_MS});
(async () => {
  const echoed = await fetch("/client-hints-echo");
  document.getElementById("client-hints").textContent = await echoed.text();
  fetch("/client-hints-done");
})();
</script>`;

const RESPONSIVE_SCRIPT = `<script>
document.getElementById("layout").textContent = matchMedia("(min-width: 1200px)").matches
  ? "desktop"
  : "tablet";
</script>`;

const WATCH_SCRIPT = `<script>
(() => {
  const seen = () => {
    fetch("/watch-seen");
  };
  const original = NavigatorUAData.prototype.getHighEntropyValues;
  NavigatorUAData.prototype.getHighEntropyValues = function (...args) {
    seen();
    return original.apply(this, args);
  };
  const memory = Object.getOwnPropertyDescriptor(Navigator.prototype, "deviceMemory");
  Object.defineProperty(Navigator.prototype, "deviceMemory", {
    ...memory,
    get() {
      seen();
      return memory.get.call(this);
    },
  });
})();
</script>`;

const MEDIA_REPORT_SCRIPT = `<script>
(async () => {
  const kinds = {};
  const named = [];
  for (const device of await navigator.mediaDevices.enumerateDevices()) {
    kinds[device.kind] = (kinds[device.kind] ?? 0) + 1;
    if (device.label !== "" || device.deviceId !== "" || device.groupId !== "") {
      named.push(device.kind);
    }
  }
  const permissions = {};
  for (const name of ["camera", "microphone"]) {
    permissions[name] = (await navigator.permissions.query({ name })).state;
  }
  const answerTo = (constraints) =>
    Promise.race([
      navigator.mediaDevices.getUserMedia(constraints).then(
        (stream) => {
          stream.getTracks().forEach((track) => track.stop());
          return "granted";
        },
        (error) => error.name,
      ),
      new Promise((resolve) => setTimeout(resolve, ${MEDIA_REQUEST_WAIT_MS}, "pending")),
    ]);
  const requests = { audio: await answerTo({ audio: true }), video: await answerTo({ video: true }) };
  document.getElementById("media").textContent = JSON.stringify({ kinds, named, permissions, requests });
  fetch("/media-done");
})();
</script>`;

const IDENTITY_REALM_SCRIPT = `${REALM_ROW_SOURCE}

const report = realmRow;

switch (self.constructor.name) {
  case "ServiceWorkerGlobalScope":
    self.addEventListener("message", (event) => event.source.postMessage(report()));
    break;
  case "SharedWorkerGlobalScope":
    self.addEventListener("connect", (event) => event.ports[0].postMessage(report()));
    break;
  default:
    postMessage(report());
}
`;

const page = (marker: string, body = "", head = ""): string =>
  `<!DOCTYPE html><html><head><meta name="xrio-page" content="${marker}">${head}${PROBE_SCRIPT}</head><body>${body}</body></html>`;

const sendPage = (response: ServerResponse, marker: string, body = "", head = ""): void => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("x-page", marker);
  response.setHeader("set-cookie", `${marker}=1; Path=/`);
  response.end(page(marker, body, head));
};

const redirect = (response: ServerResponse, location: string, cookie: string): void => {
  response.writeHead(302, { location, "set-cookie": `${cookie}=1; Path=/` });
  response.end();
};

const BUSY_AFTER_DOM_CONTENT_LOADED = `<script>
document.addEventListener("DOMContentLoaded", () => {
  const started = new XMLHttpRequest();
  started.open("GET", "/busy-started", false);
  started.send();
  setTimeout(() => {
    for (;;) {}
  });
});
</script>`;

const busyWaiters = new Set<() => void>();

export const busyPageStarted = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<"busy">();

  busyWaiters.add(() => {
    resolve("busy");
  });
  await promise;
};

const releaseBusyWaiters = (): void => {
  for (const release of busyWaiters) {
    release();
  }

  busyWaiters.clear();
};

const requestedPaths = new Set<string>();

const heldScripts = new Map<string, ServerResponse[]>();

const endScript = (response: ServerResponse): void => {
  response.setHeader("content-type", "text/javascript");
  response.end("");
};

const holdScriptUntilRequested =
  (awaited: string) =>
  (response: ServerResponse): void => {
    if (requestedPaths.has(awaited)) {
      endScript(response);

      return;
    }

    heldScripts.set(awaited, [...(heldScripts.get(awaited) ?? []), response]);
  };

export const wasRequested = (pathname: string): boolean => requestedPaths.has(pathname);

const recordRequest = (pathname: string): void => {
  requestedPaths.add(pathname);

  for (const response of heldScripts.get(pathname) ?? []) {
    endScript(response);
  }

  heldScripts.delete(pathname);
};

const hugeBody = (): string => "<p>x</p>".repeat(HUGE_DOM_ELEMENTS);

const sendFilledPage = (response: ServerResponse, marker: string, filler: number): void => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("x-page", marker);
  response.end(
    `<!DOCTYPE html><html><head><meta name="xrio-page" content="${marker}"></head><body><!--${"x".repeat(filler)}--><p id="last">${marker}-end</p></body></html>`,
  );
};

const routes = new Map<
  string,
  (response: ServerResponse, origins: FixtureOrigins, request: IncomingMessage) => void
>([
  [
    "/static",
    (response) => {
      sendPage(response, "static", "<h1>Static</h1>");
    },
  ],
  [
    "/redirect/1",
    (response) => {
      redirect(response, "/redirect/2", "hop1");
    },
  ],
  [
    "/redirect/2",
    (response) => {
      redirect(response, "/landing", "hop2");
    },
  ],
  [
    "/landing",
    (response, _origins, request) => {
      sendPage(response, "landing", `<p id="sent-cookies">${request.headers.cookie ?? ""}</p>`);
    },
  ],
  [
    "/redirect-to-closed-port",
    (response) => {
      void (async () => {
        const port = await closedLoopbackPort();

        sendPage(
          response,
          "redirect-to-closed-port",
          "",
          `<script>location.replace("http://127.0.0.1:${port}/");</script><script src="/hang"></script>`,
        );
      })();
    },
  ],
  [
    "/replace-with-blank",
    (response) => {
      sendPage(
        response,
        "replace-with-blank",
        "",
        '<script>location.replace("about:blank");</script><script src="/hang"></script>',
      );
    },
  ],
  [
    "/meta-refresh",
    (response) => {
      sendPage(response, "meta-refresh", "", '<meta http-equiv="refresh" content="0;url=/static">');
    },
  ],
  [
    "/js-redirect",
    (response) => {
      sendPage(response, "js-redirect", "", '<script>location.replace("/static");</script>');
    },
  ],
  [
    "/push-state",
    (response) => {
      sendPage(
        response,
        "push-state",
        "",
        '<script>history.pushState({}, "", "/pushed");</script>',
      );
    },
  ],
  [
    "/iframe",
    (response, { crossOrigin }) => {
      requestedPaths.delete("/framed-pixel");
      sendPage(
        response,
        "iframe",
        `<iframe src="${crossOrigin}/framed"></iframe><script src="/after-frame.js"></script>`,
      );
    },
  ],
  ["/after-frame.js", holdScriptUntilRequested("/framed-pixel")],
  [
    "/framed",
    (response) => {
      sendPage(response, "framed", '<img src="/framed-pixel">');
    },
  ],
  [
    "/worker",
    (response) => {
      requestedPaths.delete("/from-worker");
      sendPage(
        response,
        "worker",
        '<script>new Worker("/worker.js");</script><script src="/after-worker.js"></script>',
      );
    },
  ],
  [
    "/worker.js",
    (response) => {
      response.setHeader("content-type", "text/javascript");
      response.end('fetch("/from-worker");');
    },
  ],
  ["/after-worker.js", holdScriptUntilRequested("/from-worker")],
  [
    "/from-worker",
    (response) => {
      response.end("ok");
    },
  ],
  [
    "/nested-worker",
    (response) => {
      requestedPaths.delete("/from-nested");
      sendPage(
        response,
        "nested-worker",
        '<script>new Worker("/outer-worker.js");</script><script src="/after-nested-worker.js"></script>',
      );
    },
  ],
  [
    "/outer-worker.js",
    (response) => {
      response.setHeader("content-type", "text/javascript");
      response.end('new Worker("/inner-worker.js");');
    },
  ],
  [
    "/inner-worker.js",
    (response) => {
      response.setHeader("content-type", "text/javascript");
      response.end('fetch("/from-nested");');
    },
  ],
  ["/after-nested-worker.js", holdScriptUntilRequested("/from-nested")],
  [
    "/from-nested",
    (response) => {
      response.end("ok");
    },
  ],
  [
    "/download",
    (response) => {
      response.writeHead(200, {
        "content-disposition": 'attachment; filename="file.bin"',
        "content-type": "application/octet-stream",
      });
      response.end("binary");
    },
  ],
  [
    "/json",
    (response) => {
      response.setHeader("content-type", "application/json");
      response.end('{"page":"json"}');
    },
  ],
  [
    "/xml",
    (response) => {
      response.setHeader("content-type", "application/xml");
      response.end('<?xml version="1.0"?><page>xml</page>');
    },
  ],
  [
    "/pdf",
    (response) => {
      response.setHeader("content-type", "application/pdf");
      response.end("%PDF-1.4\n%%EOF\n");
    },
  ],
  [
    "/no-content",
    (response) => {
      response.writeHead(204);
      response.end();
    },
  ],
  [
    "/hanging-subresource",
    (response) => {
      sendPage(response, "hanging-subresource", '<img src="/hang">');
    },
  ],
  [
    "/hang",
    (response) => {
      response.flushHeaders();
    },
  ],
  [
    "/busy",
    (response) => {
      sendPage(response, "busy", "", BUSY_AFTER_DOM_CONTENT_LOADED);
    },
  ],
  [
    "/busy-started",
    (response) => {
      response.end("");
      releaseBusyWaiters();
    },
  ],
  [
    "/huge",
    (response) => {
      sendPage(response, "huge", hugeBody());
    },
  ],
  [
    "/sliced",
    (response) => {
      sendFilledPage(response, "sliced", SLICED_FILLER_CODE_UNITS);
    },
  ],
  [
    "/too-large",
    (response) => {
      sendFilledPage(response, "too-large", OVERSIZED_FILLER_CODE_UNITS);
    },
  ],
  [
    "/legacy-charset",
    (response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=windows-1251",
        "x-page": "legacy-charset",
      });
      response.end(
        Buffer.concat([
          Buffer.from(
            '<!DOCTYPE html><html><head><meta name="xrio-page" content="legacy-charset"></head><body><p id="text">',
          ),
          CYRILLIC_WINDOWS_1251,
          Buffer.from("</p></body></html>"),
        ]),
      );
    },
  ],
  [
    "/alert",
    (response) => {
      sendPage(response, "alert", "", '<script>alert("before DOMContentLoaded");</script>');
    },
  ],
  [
    "/basic-auth",
    (response) => {
      response.writeHead(401, {
        "content-type": "text/html",
        "www-authenticate": 'Basic realm="xrio"',
        "x-page": "basic-auth",
      });
      response.end(page("basic-auth"));
    },
  ],
  [
    "/empty-403",
    (response) => {
      response.writeHead(403, { "set-cookie": "empty-403=1; Path=/", "x-page": "empty-403" });
      response.end();
    },
  ],
  [
    "/strict-csp",
    (response) => {
      response.setHeader("content-security-policy", "default-src 'none'; script-src 'none'");
      sendPage(response, "strict-csp");
    },
  ],
  [
    "/identity",
    (response, { crossOrigin }, request) => {
      requestedPaths.delete("/identity-sized");
      requestedPaths.delete("/identity-realms-done");
      sendPage(
        response,
        "identity",
        `<pre id="identity"></pre><script type="application/json" id="identity-workers"></script>${WINDOW_SIZE_WATCH}<script src="/identity-settled.js"></script>${identityReportScript(crossOrigin)}<script src="/identity-realms-settled.js"></script>`,
        `<meta name="request-accept-language" content="${request.headers["accept-language"] ?? ""}">`,
      );
    },
  ],
  [
    "/responsive",
    (response) => {
      sendPage(response, "responsive", `<p id="layout"></p>${RESPONSIVE_SCRIPT}`);
    },
  ],
  [
    "/watch",
    (response) => {
      requestedPaths.delete("/watch-seen");
      sendPage(response, "watch", "", WATCH_SCRIPT);
    },
  ],
  [
    "/watch-control",
    (response) => {
      requestedPaths.delete("/watch-seen");
      sendPage(
        response,
        "watch-control",
        `<script>${afterCaptureRead(250)}</script>`,
        WATCH_SCRIPT,
      );
    },
  ],
  [
    "/watch-seen",
    (response) => {
      response.writeHead(204);
      response.end();
    },
  ],
  [
    "/media",
    (response) => {
      requestedPaths.delete("/media-done");
      sendPage(
        response,
        "media",
        `<pre id="media"></pre>${MEDIA_REPORT_SCRIPT}<script src="/media-settled.js"></script>`,
      );
    },
  ],
  [
    "/media-done",
    (response) => {
      response.writeHead(204);
      response.end();
    },
  ],
  ["/media-settled.js", holdScriptUntilRequested("/media-done")],
  ["/identity-settled.js", holdScriptUntilRequested("/identity-sized")],
  ["/identity-realms-settled.js", holdScriptUntilRequested("/identity-realms-done")],
  [
    "/identity-realms-done",
    (response) => {
      response.writeHead(204);
      response.end();
    },
  ],
  [
    "/identity-frame",
    (response) => {
      sendPage(response, "identity-frame", IDENTITY_FRAME_SCRIPT);
    },
  ],
  [
    "/identity-service-frame",
    (response) => {
      sendPage(response, "identity-service-frame", IDENTITY_SERVICE_FRAME_SCRIPT);
    },
  ],
  [
    "/client-hints",
    (response) => {
      requestedPaths.delete("/client-hints-done");
      response.setHeader("accept-ch", "Device-Memory, Sec-CH-Device-Memory");
      sendPage(
        response,
        "client-hints",
        `<pre id="client-hints"></pre>${CLIENT_HINTS_SCRIPT}<script src="/client-hints-settled.js"></script>`,
      );
    },
  ],
  [
    "/client-hints-echo",
    (response, _origins, request) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.headers));
    },
  ],
  [
    "/client-hints-done",
    (response) => {
      response.writeHead(204);
      response.end();
    },
  ],
  ["/client-hints-settled.js", holdScriptUntilRequested("/client-hints-done")],
  [
    "/identity-realm.js",
    (response) => {
      response.setHeader("content-type", "text/javascript");
      response.end(IDENTITY_REALM_SCRIPT);
    },
  ],
  [
    "/xhtml",
    (response) => {
      response.writeHead(200, { "content-type": "application/xhtml+xml", "x-page": "xhtml" });
      response.end(
        '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="xrio-page" content="xhtml"/><title>x</title></head><body><p>xhtml</p></body></html>',
      );
    },
  ],
]);

export const conformancePages: FixtureHandler = (request, response, origins) => {
  const { pathname } = new URL(request.url ?? "/", origins.origin);
  const route = routes.get(pathname);

  recordRequest(pathname);

  if (route === undefined) {
    response.writeHead(404);
    response.end();

    return;
  }

  route(response, origins, request);
};
