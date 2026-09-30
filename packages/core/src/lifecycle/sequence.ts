/** Runs an async step for each item, one after another. Order matters for plugins and lifecycle. */
export const eachInOrder = async <T>(
  items: readonly T[],
  step: (item: T) => Promise<void>,
): Promise<void> => {
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next begins
    await step(item);
  }
};
