import { afterEach, describe, expect, it } from "vite-plus/test";

import { createHttpEngine } from "./engines/http.ts";
import { Xrio, XrioError, definePlugin } from "./index.ts";
import type { Engine, Page, Plugin, ScrapeMode } from "./index.ts";

const PAGE: Page = { finalUrl: "https://example.com/final", html: "<h1>Hi</h1>", status: 200 };

const fakeEngine = (mode: ScrapeMode, page: Page = PAGE): Engine => ({
  fetch: async () => await Promise.resolve(page),
  mode,
});

/** Records the order in which hooks fire so tests can assert on the pipeline. */
const recordingPlugin = (name: string, calls: string[]): Plugin =>
  definePlugin({
    hooks: {
      afterFetch: () => {
        calls.push(`${name}:afterFetch`);
      },
      afterScrape: () => {
        calls.push(`${name}:afterScrape`);
      },
      beforeScrape: () => {
        calls.push(`${name}:beforeScrape`);
      },
      start: () => {
        calls.push(`${name}:start`);
      },
      stop: () => {
        calls.push(`${name}:stop`);
      },
    },
    name,
  });

const errorCodeOf = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
  } catch (error) {
    return error instanceof XrioError ? error.code : "not-a-xrio-error";
  }

  return undefined;
};

describe(Xrio, () => {
  const running: Xrio[] = [];

  const started = async (xrio: Xrio): Promise<Xrio> => {
    await xrio.start();
    running.push(xrio);

    return xrio;
  };

  afterEach(async () => {
    await Promise.all(
      running.splice(0).map(async (xrio) => {
        await xrio.stop();
      }),
    );
  });

  describe("Xrio lifecycle", () => {
    it("refuses to scrape before it is started", async () => {
      const xrio = Xrio.create({ log: { enabled: false } });

      await expect(errorCodeOf(xrio.scrape({ url: "https://example.com" }))).resolves.toBe(
        "not_started",
      );
    });

    it("refuses new plugins once started and a second start", async () => {
      const xrio = await started(Xrio.create({ log: { enabled: false } }));

      expect(() => xrio.use(recordingPlugin("late", []))).toThrow(/before Xrio starts/u);
      await expect(errorCodeOf(xrio.start())).resolves.toBe("already_started");
    });

    it("starts plugins in registration order and stops them in reverse", async () => {
      const calls: string[] = [];

      const xrio = Xrio.create({ log: { enabled: false } })
        .use(recordingPlugin("a", calls))
        .use(recordingPlugin("b", calls));

      await xrio.start();
      await xrio.stop();

      expect(calls).toStrictEqual(["a:start", "b:start", "b:stop", "a:stop"]);
    });

    it("rejects two plugins with the same name", () => {
      const xrio = Xrio.create({ log: { enabled: false } }).use(recordingPlugin("dup", []));

      expect(() => xrio.use(recordingPlugin("dup", []))).toThrow(/already registered/u);
    });
  });

  describe("Xrio plugins", () => {
    it("reports the pipeline steps each plugin declares", () => {
      const xrio = Xrio.create({ log: { enabled: false } })
        .use(recordingPlugin("all", []))
        .use(definePlugin({ hooks: { resolveRoute: () => ({}) }, name: "proxy" }));

      expect(xrio.plugins).toStrictEqual([
        {
          name: "all",
          steps: ["start", "stop", "beforeScrape", "afterFetch", "afterScrape"],
        },
        { name: "proxy", steps: ["resolveRoute"] },
      ]);
    });

    it("runs every declared hook around the fetch, in registration order", async () => {
      const calls: string[] = [];

      const xrio = Xrio.create({ log: { enabled: false } })
        .use(recordingPlugin("a", calls))
        .use(recordingPlugin("b", calls))
        .use(definePlugin({ engines: [fakeEngine("headless")], hooks: {}, name: "browser" }));

      await started(xrio);
      calls.length = 0;

      await xrio.scrape({ mode: "headless", url: "https://example.com" });

      expect(calls).toStrictEqual([
        "a:beforeScrape",
        "b:beforeScrape",
        "a:afterFetch",
        "b:afterFetch",
        "a:afterScrape",
        "b:afterScrape",
      ]);
    });

    it("lets plugins rewrite the request, choose the route and rewrite the page", async () => {
      const seen = { proxyUrl: "", url: "" };

      const recordingEngine: Engine = {
        fetch: async (request, route) => {
          seen.url = request.url;
          seen.proxyUrl = route.proxyUrl ?? "";

          return await Promise.resolve(PAGE);
        },
        mode: "headless",
      };

      const xrio = Xrio.create({ log: { enabled: false } });
      xrio.use(
        definePlugin({
          engines: [recordingEngine],
          hooks: {
            afterFetch: ({ page }) => ({ ...page, html: page.html.toUpperCase() }),
            beforeScrape: ({ request }) => ({ ...request, url: "https://rewritten.test/" }),
            resolveRoute: () => ({ proxyUrl: "http://proxy.test:8080" }),
          },
          name: "rewriter",
        }),
      );
      await started(xrio);

      const result = await xrio.scrape({ mode: "headless", url: "https://example.com" });

      expect(result.content).toBe("<H1>HI</H1>");
      expect(result.url).toBe("https://rewritten.test/");
      expect(seen).toStrictEqual({
        proxyUrl: "http://proxy.test:8080",
        url: "https://rewritten.test/",
      });
    });

    it("wraps a failing hook in plugin_failed and reports it to onError", async () => {
      const reported: string[] = [];
      const xrio = Xrio.create({ log: { enabled: false } });
      xrio.use(
        definePlugin({
          hooks: {
            afterScrape: () => {
              throw new Error("database down");
            },
            onError: ({ error }) => {
              reported.push(error.message);
            },
          },
          name: "database",
        }),
      );
      xrio.use(definePlugin({ engines: [fakeEngine("headless")], hooks: {}, name: "browser" }));
      await started(xrio);

      const code = await errorCodeOf(xrio.scrape({ mode: "headless", url: "https://example.com" }));

      expect(code).toBe("plugin_failed");
      expect(reported).toStrictEqual(['Plugin "database" failed during afterScrape.']);
    });

    it("rejects an engine for a mode that is already served", () => {
      const xrio = Xrio.create({ log: { enabled: false } });

      expect(() =>
        xrio.use(definePlugin({ engines: [fakeEngine("http")], hooks: {}, name: "second-http" })),
      ).toThrow(/already registered/u);
    });
  });

  describe("Xrio scraping", () => {
    it("reports engine_unavailable for a mode nobody provides", async () => {
      const xrio = await started(Xrio.create({ log: { enabled: false } }));

      await expect(
        errorCodeOf(xrio.scrape({ mode: "headful", url: "https://example.com" })),
      ).resolves.toBe("engine_unavailable");
    });

    it("validates input and unsupported formats before any request is made", async () => {
      const xrio = await started(Xrio.create({ log: { enabled: false } }));

      await expect(errorCodeOf(xrio.scrape({ url: "not a url" }))).resolves.toBe("invalid_request");
      await expect(
        errorCodeOf(xrio.scrape({ format: "md", url: "https://example.com" })),
      ).resolves.toBe("format_unsupported");
    });

    it("serves many scrapes from one instance and renders each format", async () => {
      const xrio = Xrio.create({ log: { enabled: false } });
      xrio.use(definePlugin({ engines: [fakeEngine("headless")], hooks: {}, name: "browser" }));
      await started(xrio);

      const [html, json, xml, csv] = await Promise.all(
        (["html", "json", "xml", "csv"] as const).map(
          async (format) =>
            await xrio.scrape({ format, mode: "headless", url: "https://example.com" }),
        ),
      );

      expect(html?.content).toBe("<h1>Hi</h1>");
      expect(JSON.parse(json?.content ?? "{}")).toMatchObject({ html: "<h1>Hi</h1>", status: 200 });
      expect(xml?.content).toContain("<html><![CDATA[<h1>Hi</h1>]]></html>");
      expect(csv?.content).toContain('"https://example.com/","https://example.com/final","200"');
    });
  });

  describe("http engine and API", () => {
    it("reads status, final URL and body from the http engine's fetch", async () => {
      const engine = createHttpEngine({
        fetch: async () => await Promise.resolve(new Response("<p>hello</p>", { status: 404 })),
      });

      const page = await engine.fetch(
        { format: "html", mode: "http", url: "https://example.com/" },
        {},
      );

      expect(page).toStrictEqual({
        finalUrl: "https://example.com/",
        html: "<p>hello</p>",
        status: 404,
      });
    });

    it("refuses to send a proxied route through the http engine", async () => {
      const engine = createHttpEngine({
        fetch: async () => await Promise.resolve(new Response("x")),
      });

      await expect(
        engine.fetch(
          { format: "html", mode: "http", url: "https://example.com/" },
          { proxyUrl: "http://proxy.test" },
        ),
      ).rejects.toMatchObject({ code: "engine_unavailable" });
    });

    it("reports a network failure as fetch_failed", async () => {
      const engine = createHttpEngine({
        fetch: async () => await Promise.reject(new Error("boom")),
      });

      await expect(
        engine.fetch({ format: "html", mode: "http", url: "https://example.com/" }, {}),
      ).rejects.toMatchObject({ code: "fetch_failed" });
    });
  });

  describe("failure handling", () => {
    const plainFailure = definePlugin({
      engines: [
        {
          fetch: async () => await Promise.reject(new Error("engine exploded")),
          mode: "headful",
        },
      ],
      hooks: {},
      name: "plain-failure",
    });

    it("rethrows an engine's own error, reports it to onError and logs it as unknown", async () => {
      const lines: string[] = [];
      const reported: Error[] = [];

      const xrio = Xrio.create({
        log: {
          sink: (line) => {
            lines.push(line);
          },
        },
      })
        .use(plainFailure)
        .use(
          definePlugin({
            hooks: {
              onError: ({ error }) => {
                reported.push(error);
              },
            },
            name: "reporter",
          }),
        );

      await started(xrio);

      await expect(xrio.scrape({ mode: "headful", url: "https://example.com" })).rejects.toThrow(
        "engine exploded",
      );

      expect(reported.map((error) => error.message)).toStrictEqual(["engine exploded"]);
      expect(lines.some((line) => line.includes('code="unknown"'))).toBeTruthy();
    });

    it("keeps the original failure when an onError hook itself throws", async () => {
      const lines: string[] = [];

      const xrio = Xrio.create({
        log: {
          level: "debug",
          sink: (line) => {
            lines.push(line);
          },
        },
      })
        .use(plainFailure)
        .use(
          definePlugin({
            hooks: {
              onError: () => {
                throw new Error("reporter down");
              },
            },
            name: "flaky-reporter",
          }),
        );

      await started(xrio);

      await expect(xrio.scrape({ mode: "headful", url: "https://example.com" })).rejects.toThrow(
        "engine exploded",
      );

      expect(lines.some((line) => line.includes("plugin onError hook failed"))).toBeTruthy();
      expect(lines.some((line) => line.includes("reporter down"))).toBeTruthy();
    });

    it("lets the first plugin that answers resolveRoute win and skips the rest", async () => {
      const asked: string[] = [];

      const routing = (name: string, proxyUrl: string): Plugin =>
        definePlugin({
          hooks: {
            resolveRoute: () => {
              asked.push(name);

              return { proxyUrl };
            },
          },
          name,
        });

      const seen: string[] = [];

      const recorder = definePlugin({
        engines: [
          {
            fetch: async (_request, route) => {
              seen.push(route.proxyUrl ?? "none");

              return await Promise.resolve(PAGE);
            },
            mode: "headless",
          },
        ],
        hooks: {},
        name: "recorder",
      });

      const xrio = Xrio.create({ log: { enabled: false } })
        .use(recorder)
        .use(routing("first", "http://first.test"))
        .use(routing("second", "http://second.test"));

      await started(xrio);

      await xrio.scrape({ mode: "headless", url: "https://example.com" });

      expect(seen).toStrictEqual(["http://first.test"]);
      expect(asked).toStrictEqual(["first"]);
    });

    it("rolls back earlier plugins when a later one fails to start, and stays stopped", async () => {
      const calls: string[] = [];

      const xrio = Xrio.create({ log: { enabled: false } })
        .use(recordingPlugin("good", calls))
        .use(
          definePlugin({
            hooks: {
              start: () => {
                throw new Error("cannot connect");
              },
            },
            name: "bad",
          }),
        );

      await expect(xrio.start()).rejects.toMatchObject({ code: "plugin_failed" });

      expect(calls).toStrictEqual(["good:start", "good:stop"]);
      await expect(errorCodeOf(xrio.scrape({ url: "https://example.com" }))).resolves.toBe(
        "not_started",
      );
    });

    it("treats stop as a no-op when never started", async () => {
      const calls: string[] = [];
      const xrio = Xrio.create({ log: { enabled: false } }).use(recordingPlugin("idle", calls));

      await xrio.stop();

      expect(calls).toStrictEqual([]);
    });
  });

  describe("logging", () => {
    const withBrowser = definePlugin({
      engines: [fakeEngine("headless")],
      hooks: {},
      name: "browser",
    });

    it("logs the lifecycle and each scrape at info level, but not debug detail", async () => {
      const lines: string[] = [];

      const xrio = Xrio.create({
        log: {
          level: "info",
          sink: (line) => {
            lines.push(line);
          },
        },
      }).use(withBrowser);

      await started(xrio);
      await xrio.scrape({ mode: "headless", url: "https://example.com" });
      await xrio.stop();

      const text = lines.join("\n");

      expect(text).toContain("xrio started");
      expect(text).toContain("scrape started");
      expect(text).toContain("scrape finished");
      expect(text).toContain("xrio stopped");
      expect(text).not.toContain("plugin step");
    });

    it("adds plugin steps at debug level", async () => {
      const lines: string[] = [];

      const xrio = Xrio.create({
        log: {
          level: "debug",
          sink: (line) => {
            lines.push(line);
          },
        },
      }).use(withBrowser);

      await started(xrio);

      expect(lines.join("\n")).toContain("plugin registered");
    });

    it("stays silent when logging is disabled and hands plugins a working logger", async () => {
      const lines: string[] = [];
      const seen: string[] = [];

      const xrio = Xrio.create({
        log: {
          enabled: false,
          sink: (line) => {
            lines.push(line);
          },
        },
      })
        .use(withBrowser)
        .use(
          definePlugin({
            hooks: {
              afterScrape: ({ logger }) => {
                logger.info("from plugin");
                seen.push("called");
              },
            },
            name: "chatty",
          }),
        );

      await started(xrio);
      await xrio.scrape({ mode: "headless", url: "https://example.com" });

      expect(lines).toStrictEqual([]);
      expect(seen).toStrictEqual(["called"]);
    });

    it("routes plugin log lines through the configured sink", async () => {
      const lines: string[] = [];

      const xrio = Xrio.create({
        log: {
          sink: (line) => {
            lines.push(line);
          },
        },
      })
        .use(withBrowser)
        .use(
          definePlugin({
            hooks: {
              afterScrape: ({ logger }) => {
                logger.info("from plugin");
              },
            },
            name: "chatty",
          }),
        );

      await started(xrio);
      await xrio.scrape({ mode: "headless", url: "https://example.com" });

      expect(lines.some((line) => line.includes("from plugin"))).toBeTruthy();
    });
  });
});
