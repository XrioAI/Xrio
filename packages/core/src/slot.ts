export class Slot implements AsyncDisposable {
  readonly #release: (() => void) | undefined;
  #released = false;

  constructor(release?: () => void) {
    this.#release = release;
  }

  assertHeld(): void {
    if (this.#released) {
      throw new Error("The admission slot has been released.");
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.#released) {
      this.#released = true;
      this.#release?.();
    }

    await Promise.resolve();
  }
}
