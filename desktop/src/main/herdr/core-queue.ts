// One reader's queue of items, then an end: the TS form of the Swift
// client's AsyncStream / AsyncThrowingStream, so the port reads a link's
// bytes, a channel's frames and the event lines with the same `for await`
// loops the Swift code has.

export class CoreQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private head = 0;
  private ended = false;
  private failure: { readonly error: unknown } | null = null;
  private waiter: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void } | null = null;
  private terminations: (() => void)[] = [];

  /** Adds an item; false once the queue has ended (the item is dropped). */
  push(item: T): boolean {
    if (this.ended) return false;
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter.resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
    return true;
  }

  /** Ends the queue after the items already in it; an error makes the reader throw it there. Idempotent. */
  finish(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    if (error !== undefined) this.failure = { error };
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter !== null) {
      if (this.failure !== null) waiter.reject(this.failure.error);
      else waiter.resolve({ value: undefined, done: true });
    }
    this.terminate();
  }

  /** Runs once when the queue ends or its reader stops (Swift's onTermination). */
  onTermination(listener: () => void): void {
    if (this.ended) listener();
    else this.terminations.push(listener);
  }

  private terminate(): void {
    const all = this.terminations;
    this.terminations = [];
    for (const listener of all) listener();
  }

  get isFinished(): boolean {
    return this.ended;
  }

  /** Items waiting to be read. */
  get pendingCount(): number {
    return this.items.length - this.head;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.head < this.items.length) {
      const value = this.items[this.head] as T;
      this.head += 1;
      if (this.head > 1024 && this.head * 2 > this.items.length) {
        this.items = this.items.slice(this.head);
        this.head = 0;
      }
      return Promise.resolve({ value, done: false });
    }
    if (this.ended) {
      return this.failure !== null ? Promise.reject(this.failure.error) : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** The next item, or null at the end (throws the end's error). */
  async take(): Promise<T | null> {
    const result = await this.next();
    return result.done === true ? null : result.value;
  }

  /** The reader stops: the queue ends and drops what it holds. */
  cancel(): void {
    this.items = [];
    this.head = 0;
    this.finish();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: () => {
        this.cancel();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
