import type { AbortReason, Deadline } from "./deadline.ts";

export class HeldDeadline implements Deadline {
  readonly #deadline: Deadline;

  constructor(deadline: Deadline, ownership: AbortSignal) {
    this.#deadline = deadline.boundTo(ownership, "ownership");
  }

  get signal(): AbortSignal {
    return this.#deadline.signal;
  }

  abortReason = (): AbortReason | undefined => this.#deadline.abortReason();
  remainingMs = (): number => this.#deadline.remainingMs();
  throwIfExpired = (): void => {
    this.#deadline.throwIfExpired();
  };
  stageTimeout: Deadline["stageTimeout"] = (capMs) => this.#deadline.stageTimeout(capMs);
  startStage: Deadline["startStage"] = (capMs) => this.#deadline.startStage(capMs);
  boundTo: Deadline["boundTo"] = (signal, reason) => this.#deadline.boundTo(signal, reason);
}
