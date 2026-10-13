const PERCENTILES = [50, 95] as const;

const DECIMALS = 2;

export type Metrics = Readonly<Record<string, number | null>>;

export interface Measured {
  readonly target: string;
  readonly metrics: Metrics;
}

const percentile = (sorted: readonly number[], rank: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1)] ?? Number.NaN;

const summariseColumn = (values: readonly (number | null)[]) => {
  const present = values.filter((value) => value !== null).toSorted((a, b) => a - b);

  if (present.length === 0) {
    return null;
  }

  return Object.fromEntries(
    PERCENTILES.map((rank) => [`p${rank}`, Number(percentile(present, rank).toFixed(DECIMALS))]),
  );
};

const summariseTarget = (samples: readonly Measured[]) =>
  Object.fromEntries(
    Object.keys(samples[0]?.metrics ?? {}).map((name) => [
      name,
      summariseColumn(samples.map((sample) => sample.metrics[name] ?? null)),
    ]),
  );

export const summarise = (samples: readonly Measured[]) => {
  const targets = [...new Set(samples.map((sample) => sample.target))];

  return Object.fromEntries(
    targets.map((target) => [
      target,
      summariseTarget(samples.filter((sample) => sample.target === target)),
    ]),
  );
};
