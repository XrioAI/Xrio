import { parseArgs } from "node:util";

export interface BenchOptions {
  readonly mode: "headless" | "headed";
  readonly out: string | undefined;
  readonly route: string;
  readonly runs: number;
  readonly warmup: number;
}

const parseMode = (value: string): "headless" | "headed" => {
  if (value !== "headless" && value !== "headed") {
    throw new Error(`--mode must be headless or headed, not "${value}".`);
  }

  return value;
};

const parseCount = (flag: string, value: string, least: number): number => {
  const count = Number(value);

  if (!Number.isInteger(count) || count < least) {
    throw new Error(`--${flag} must be an integer of at least ${least}, not "${value}".`);
  }

  return count;
};

export const readBenchOptions = (): BenchOptions => {
  const { values } = parseArgs({
    options: {
      mode: { default: "headless", type: "string" },
      out: { type: "string" },
      route: { default: "/static", type: "string" },
      runs: { default: "10", type: "string" },
      warmup: { default: "1", type: "string" },
    },
  });

  return {
    mode: parseMode(values.mode),
    out: values.out,
    route: values.route,
    runs: parseCount("runs", values.runs, 1),
    warmup: parseCount("warmup", values.warmup, 0),
  };
};
