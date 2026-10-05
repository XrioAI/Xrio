import { availableParallelism, totalmem } from "node:os";
import { constrainedMemory } from "node:process";

import type { Deadline } from "./deadline.ts";
import { clientClosed } from "./errors.ts";
import type { ScrapeIntent } from "./intent.ts";
import { Slot } from "./slot.ts";

const BYTES_PER_BROWSER = 512 * 1024 * 1024;

const defaultCapacity = (): number => {
  const limit = constrainedMemory();
  const memory = limit > 0 ? Math.min(limit, totalmem()) : totalmem();

  return Math.max(1, Math.min(availableParallelism(), Math.floor(memory / BYTES_PER_BROWSER)));
};

interface Waiting {
  readonly offer: () => void;
  readonly reject: () => void;
}

export interface Admission {
  readonly close: () => void;
  readonly slotFor: (source: ScrapeIntent["source"], deadline: Deadline) => Promise<Slot>;
}

export const createAdmission = (capacity = defaultCapacity()): Admission => {
  const queue = new Set<Waiting>();
  let active = 0;
  let closed = false;

  const offerCapacity = () => {
    for (const waiting of queue) {
      if (active >= capacity) {
        return;
      }

      queue.delete(waiting);
      waiting.offer();
    }
  };

  const takeSlot = (): Slot => {
    active += 1;

    return new Slot(() => {
      active -= 1;
      offerCapacity();
    });
  };

  const slotFor: Admission["slotFor"] = async (source, deadline) => {
    deadline.throwIfExpired();

    if (source.mode === "http") {
      return new Slot();
    }

    if (closed) {
      throw clientClosed();
    }

    if (active < capacity && queue.size === 0) {
      return takeSlot();
    }

    const ready = Promise.withResolvers<Slot>();

    const waiting: Waiting = {
      offer: () => {
        if (deadline.signal.aborted) {
          ready.reject(deadline.signal.reason);

          return;
        }

        ready.resolve(takeSlot());
      },
      reject: () => {
        ready.reject(clientClosed());
      },
    };

    const abort = () => {
      queue.delete(waiting);
      ready.reject(deadline.signal.reason);
      offerCapacity();
    };

    queue.add(waiting);
    deadline.signal.addEventListener("abort", abort, { once: true });

    if (deadline.signal.aborted) {
      abort();
    }

    try {
      const slot = await ready.promise;

      if (deadline.signal.aborted) {
        await slot[Symbol.asyncDispose]();
        deadline.throwIfExpired();
      }

      return slot;
    } finally {
      deadline.signal.removeEventListener("abort", abort);
    }
  };

  const close = () => {
    closed = true;

    for (const waiting of queue) {
      waiting.reject();
    }

    queue.clear();
  };

  return { close, slotFor };
};
