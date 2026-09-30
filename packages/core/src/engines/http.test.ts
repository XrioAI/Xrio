import { describe, expect, it } from "vite-plus/test";

import { createHttpEngine } from "./http.ts";

const request = { format: "html", mode: "http", url: "https://example.com/start" } as const;

describe(createHttpEngine, () => {
  it("reports the final URL after redirects", async () => {
    const redirected = new Response("<p>hi</p>", { status: 200 });
    Object.defineProperty(redirected, "url", { value: "https://example.com/landed" });
    const engine = createHttpEngine({ fetch: async () => await Promise.resolve(redirected) });

    const page = await engine.fetch(request, {});

    expect(page.finalUrl).toBe("https://example.com/landed");
  });

  it("falls back to the requested URL when the response has none", async () => {
    const engine = createHttpEngine({
      fetch: async () => await Promise.resolve(new Response("<p>hi</p>")),
    });

    const page = await engine.fetch(request, {});

    expect(page.finalUrl).toBe("https://example.com/start");
  });

  it("returns error statuses as pages instead of failing", async () => {
    const engine = createHttpEngine({
      fetch: async () => await Promise.resolve(new Response("gone", { status: 410 })),
    });

    const page = await engine.fetch(request, {});

    expect(page).toMatchObject({ html: "gone", status: 410 });
  });

  it("gives the fetch an abort signal so a slow site cannot hang forever", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];

    const engine = createHttpEngine({
      fetch: async (_url, init) => {
        signals.push(init?.signal);

        return await Promise.resolve(new Response("ok"));
      },
      timeoutMs: 5000,
    });

    await engine.fetch(request, {});

    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });
});
