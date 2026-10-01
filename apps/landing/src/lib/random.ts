/** Deterministic Mulberry32 sequence keeps the disk stable across theme rebuilds. */
export const createRandom = () => {
  let seed = 0x9e_37_79_b9;

  // Mulberry32 requires 32-bit overflow and bit mixing, not arithmetic truncation.
  /* eslint-disable no-bitwise, unicorn/prefer-math-trunc */
  return () => {
    seed |= 0;
    seed = (seed + 0x6d_2b_79_f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  /* eslint-enable no-bitwise, unicorn/prefer-math-trunc */
};
