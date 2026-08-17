/** Unbounded push queue consumable as an async iterable. `close()` ends iteration once buffered items drain. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buf.push(v);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  get isClosed(): boolean { return this.closed; }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}
