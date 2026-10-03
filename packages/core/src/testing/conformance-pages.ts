import type { IncomingMessage, ServerResponse } from "node:http";

import type { FixtureHandler, FixtureOrigins } from "./fixture-server.ts";

const HUGE_DOM_ELEMENTS = 200_000;

const SLICED_FILLER_CODE_UNITS = 4 * 1024 * 1024;

const OVERSIZED_FILLER_CODE_UNITS = 33 * 1024 * 1024;

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
