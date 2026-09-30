import { toError } from "../errors.ts";
import { eachInOrder } from "./sequence.ts";

export interface Startable {
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

/** Stops every item, last started first, even when some fail; then rethrows the first failure. */
export const stopInReverse = async (items: readonly Startable[]): Promise<void> => {
  const failures: Error[] = [];

  await eachInOrder(items.toReversed(), async (item) => {
    try {
      await item.stop?.();
    } catch (error) {
      failures.push(toError(error));
    }
  });

  const [firstFailure] = failures;

  if (firstFailure !== undefined) {
    throw firstFailure;
  }
};

const stopIgnoringFailures = async (items: readonly Startable[]): Promise<void> => {
  try {
    await stopInReverse(items);
  } catch {
    // The start failure that triggered this cleanup is the error worth reporting.
  }
};

/** Starts items in order. If one fails, the ones already started are stopped and the error rethrown. */
export const startInOrder = async (items: readonly Startable[]): Promise<void> => {
  const started: Startable[] = [];

  try {
    await eachInOrder(items, async (item) => {
      await item.start?.();
      started.push(item);
    });
  } catch (error) {
    await stopIgnoringFailures(started);
    throw error;
  }
};
