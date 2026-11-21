import { ASSISTANT_CHORDS, type AssistantAction, type AssistantPageAction } from "@realm/contracts";
import type { ChordKey } from "./realm-keys";

export type AssistantKeysDeps = {
  /** RealmKeys' `registerChord`: takes the key from the app in front, and gives back the way to return it. */
  register: (key: ChordKey, run: () => void) => () => void;
  panel: { isOpen(): boolean; open(): void; close(): void; move(direction: -1 | 1): void };
  /** Tells the panel's page, once it can hear it (see `pageReady`). */
  send: (action: AssistantPageAction) => void;
  /** The panel's assistant is listening (listening-mark.ts's MeetingListening). */
  listening: () => boolean;
};

/**
 * The assistant's chords (Settings ▸ Keys ▸ From anywhere), from the key to what it does.
 *
 * A key that puts something in the panel opens it first: show, listen, answer and type. One that
 * works on what the panel shows (scrolling, moving) does nothing while it is put away, and so does
 * a Listen that would stop a run, which needs nothing on screen.
 */
export class AssistantKeys {
  private returns: (() => void)[] = [];
  private on = false;

  constructor(private readonly deps: AssistantKeysDeps) {}

  /** Read from the setting at each connect, and from Settings' switch. */
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (on) this.returns = ASSISTANT_CHORDS.map(({ key, action }) => this.deps.register(key, () => this.press(action)));
    else for (const give of this.returns.splice(0)) give();
  }

  press(action: AssistantAction): void {
    const { panel } = this.deps;
    switch (action) {
      case "toggle":
        if (panel.isOpen()) { panel.close(); return; }
        panel.open();
        this.deps.send(action);
        return;
      case "listen":
        if (!this.deps.listening()) panel.open();
        this.deps.send(action);
        return;
      case "answer":
      case "type":
        panel.open();
        this.deps.send(action);
        return;
      case "scrollDown":
      case "scrollUp":
        if (panel.isOpen()) this.deps.send(action);
        return;
      case "moveLeft":
      case "moveRight":
        if (panel.isOpen()) panel.move(action === "moveLeft" ? -1 : 1);
        return;
    }
  }
}

/**
 * The keys for a page that has not said it listens yet: one made on the key press is still loading.
 * Only the last is kept, as the page would have ended up on it anyway.
 */
export class PageInbox<P> {
  private ready: P | null = null;
  private waiting: { page: P; action: AssistantPageAction } | null = null;

  constructor(private readonly deliver: (page: P, action: AssistantPageAction) => void) {}

  send(page: P | null, action: AssistantPageAction): void {
    if (!page) return;
    if (page === this.ready) this.deliver(page, action);
    else this.waiting = { page, action };
  }

  /** The page's key listener is on. */
  pageReady(page: P): void {
    this.ready = page;
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting?.page === page) this.deliver(page, waiting.action);
  }
}
