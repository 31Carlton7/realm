/**
 * Main's seals on policy rows and tool classes, asked about over the bridge. realm-server holds the
 * rows; Electron main holds the key that seals them and the Keychain stamp that dates them, and is the
 * only side that can make a seal — at a press in Realm's own window, confirmed by macOS.
 *
 * Every failure is "not sealed": no main (a headless server, a test, a lab Mac before login), a bridge
 * that errors, an answer of the wrong shape. A row that needs a seal then reads as if it were absent,
 * which only ever tightens (the plan's risk 8: it fails closed, and the page says so).
 */
export type SealItem = {
  /** The Keychain stamp scope the seal is tied to (`policyStampScope`, `toolClassStampScope`). */
  scope: string;
  /** Exactly what the seal covers (`policySealText`, `toolClassSealText`). */
  text: string;
  seal: string;
};

export type SealBridge = {
  connected(): boolean;
  /** Does each seal open, cover exactly this text, carry this Mac, and match the stamp? */
  verify(items: SealItem[]): Promise<unknown>;
  /** The person's press for exactly this text, spent by asking: the seal main made for it, or null. */
  consume(text: string): Promise<unknown>;
  /** Move a scope's stamp on, so a copy of an older seal put back no longer checks out. Only narrows. */
  bump(scope: string): Promise<unknown>;
};

export class SealChecker {
  /** Main's answers, by scope, text and seal — an edited row is a new key and is asked about afresh. */
  private known = new Map<string, boolean>();

  constructor(private bridge: SealBridge | null) {}

  /** Whether each item's seal checks out, and whether main was asked at all. */
  async check(items: readonly SealItem[]): Promise<{ sealed: boolean[]; checked: boolean }> {
    if (items.length === 0) return { sealed: [], checked: true };
    const key = (i: SealItem) => `${i.scope}\n${i.text}\n${i.seal}`;
    const ask = items.filter((i) => !this.known.has(key(i)));
    if (ask.length > 0) {
      if (!this.bridge?.connected()) return { sealed: items.map((i) => this.known.get(key(i)) === true), checked: false };
      let answer: unknown;
      try { answer = await this.bridge.verify(ask); } catch { return { sealed: items.map(() => false), checked: false }; }
      const list = (answer as { sealed?: unknown } | null)?.sealed;
      if (!Array.isArray(list) || list.length !== ask.length) return { sealed: items.map(() => false), checked: false };
      ask.forEach((i, n) => this.known.set(key(i), list[n] === true));
    }
    return { sealed: items.map((i) => this.known.get(key(i)) === true), checked: true };
  }

  /** The seal main made at the person's press for this text, or null when there was none. */
  async consume(text: string): Promise<string | null> {
    if (!this.bridge?.connected()) return null;
    try {
      const r = (await this.bridge.consume(text)) as { seal?: unknown } | null;
      return typeof r?.seal === "string" && r.seal.length > 0 ? r.seal : null;
    } catch { return null; }
  }

  /** A tightening at this scope: older seals there stop checking out. Best effort — a tightening is
   *  written whether or not main could move the stamp. */
  async bump(scope: string): Promise<void> {
    if (!this.bridge?.connected()) return;
    try { await this.bridge.bump(scope); } catch { /* the row is written tightened either way */ }
    for (const k of this.known.keys()) if (k.startsWith(`${scope}\n`)) this.known.delete(k);
  }

  /** A seal just made for this item checks out by construction; remember it so the first call after the
   *  write does not wait on the bridge. */
  remember(item: SealItem): void {
    for (const k of this.known.keys()) if (k.startsWith(`${item.scope}\n`)) this.known.delete(k);
    this.known.set(`${item.scope}\n${item.text}\n${item.seal}`, true);
  }
}
