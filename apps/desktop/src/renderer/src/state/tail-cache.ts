/**
 * The ends of logs read ahead of a click: the sidebar rows beside the session on screen, and the row
 * under the pointer. A session opened from here paints at once and reads on from where the entry
 * stops, so an entry can be old without being wrong.
 *
 * Bounded twice: by `size` entries, the oldest put going first, and by what one
 * entry may hold — a read longer than `maxEvents` (a turn thousands of events long) is not kept.
 */
export class TailCache<T extends { events: readonly unknown[] }> {
  private readonly entries = new Map<string, T>();
  constructor(readonly size: number, readonly maxEvents: number) {}

  has(id: string): boolean { return this.entries.has(id); }

  /** The entry, removed: an opened session's transcript lives in the store from then on. */
  take(id: string): T | undefined {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    return entry;
  }

  put(id: string, entry: T): void {
    this.entries.delete(id);
    if (entry.events.length > this.maxEvents) return;
    this.entries.set(id, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.size) break;
      this.entries.delete(oldest);
    }
  }

  delete(id: string): void { this.entries.delete(id); }

  get count(): number { return this.entries.size; }
}
