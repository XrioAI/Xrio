import { setImmediate as nextTurn } from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import { CONTENT, documentHop, PAGE_URL, startedRender } from "../../testing/manual-render.ts";

const READY = { selector: "#ready" };

describe("selector waits", () => {
  it("repeats the selector hold when capture replaces the document", async () => {
    const run = startedRender(documentHop(), 10_000, READY);
    using _deadline = run.deadline;
    run.setSelector("matched");
    await nextTurn();
    run.onCapture(() => {
      run.commit(documentHop({ loaderId: "L2", requestId: "R2", status: 201 }));
      run.setSelector("absent");
    });
    await run.tick();
    await run.tick();
    await run.tick();
    run.setSelector("matched");
    await run.tick();
    await run.tick();
    await run.tick();
    const { source } = await run.result;
    expect(source.status).toBe(201);
    expect(run.time.clock.now()).toBe(1500);
  });

  it("requires a selector to hold for 500 ms in one document", async () => {
    const run = startedRender(documentHop(), 10_000, READY);
    using _deadline = run.deadline;
    run.setSelector("matched");
    await nextTurn();
    await run.tick();
    run.commit(documentHop({ loaderId: "L2", requestId: "R2" }));
    await run.tick();
    await run.tick();
    await run.tick();
    const { source } = await run.result;
    expect(source.html).toBe(CONTENT);
    expect(run.time.clock.now()).toBe(1000);
  });

  it("rejects invalid selectors", async () => {
    const run = startedRender(documentHop(), 10_000, { selector: "[" });
    using _deadline = run.deadline;
    run.setSelector("invalid");
    await expect(run.result).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("returns WAIT_FOR_TIMEOUT with the captured HTML and response", async () => {
    const run = startedRender(documentHop(), 2000, { selector: "#missing" });
    using _deadline = run.deadline;
    await nextTurn();
    await run.tick(1000);
    await expect(run.result).rejects.toMatchObject({
      code: "WAIT_FOR_TIMEOUT",
      details: { html: CONTENT, selector: "#missing", status: 200, url: PAGE_URL },
    });
  });

  it("returns TIMEOUT when capture loses the deadline", async () => {
    const run = startedRender(documentHop(), 2000, { selector: "#missing" });
    using _deadline = run.deadline;
    await nextTurn();
    run.onCapture(() => {
      run.time.advance(1000);
    });
    await run.tick(1000);
    await expect(run.result).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
