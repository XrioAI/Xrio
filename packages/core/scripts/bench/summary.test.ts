import { describe, expect, it } from "vite-plus/test";

import { summarise } from "./summary.ts";

const twenty = Array.from({ length: 20 }, (_, index) => index + 1);

describe(summarise, () => {
  it("reports the nearest-rank p50 and p95 of a column", () => {
    const summary = summarise(
      twenty.toReversed().map((answer) => ({ metrics: { answer }, target: "/static" })),
    );

    expect(summary).toStrictEqual({ "/static": { answer: { p50: 10, p95: 19 } } });
  });

  it("keeps targets apart and reports an unmeasured column as null", () => {
    const summary = summarise([
      { metrics: { answer: 100, cpu: null }, target: "https://a.example/" },
      { metrics: { answer: 300, cpu: null }, target: "https://b.example/" },
    ]);

    expect(summary).toStrictEqual({
      "https://a.example/": { answer: { p50: 100, p95: 100 }, cpu: null },
      "https://b.example/": { answer: { p50: 300, p95: 300 }, cpu: null },
    });
  });
});
