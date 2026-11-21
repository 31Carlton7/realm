import { ASSISTANT_CHORDS, type AssistantAction, type AssistantPageAction } from "@realm/contracts";
import type { ListeningPage } from "./listening-mark";
import type { ChordKey } from "./realm-keys";

export type AssistantKeysDeps = {
  /** RealmKeys' `registerChord`: takes the key from the app in front, and gives back the way to return it. */
  register: (key: ChordKey, run: () => void) => () => void;
  /** `open` gives the panel the keyboard; `openInactive` leaves it with the app in front. */
  panel: { isOpen(): boolean; open(): void; openInactive(): void; close(): void; move(direction: -1 | 1): void };
  /** Tells the panel's page, once it can hear it (see `pageReady`). */
  send: (action: AssistantPageAction) => void;
  /** The panel's assistant is listening (listening-mark.ts's MeetingListening). */
  listening: () => boolean;
  /** The panel's page shows the assistant rather than the chat, as the page last said. */
  shown: () => boolean;
};

/**
 * The assistant's chords (Settings ▸ Keys ▸ From anywhere), from the key to what it does.
 *
 * A key that puts something in the panel opens it first: show, listen, answer and type. Only type
 * gives it the keyboard; the rest leave typing with the app in front. One that works on what the
 * panel shows (scrolling, moving) does nothing while it is put away, and so does a Listen that would
 * stop a run, which needs nothing on screen.
 *
 * The chords are registered only while the setting is on and the first-run sheet has been accepted.
 */
export class AssistantKeys {
  private returns: (() => void)[] = [];
  private on = false;
  private consented = false;

  constructor(private readonly deps: AssistantKeysDeps) {}

  /** The chords are registered now. */
  get live(): boolean { return this.returns.length > 0; }

  /** Read from the setting at each connect, and from Settings' switch. */
  set(on: boolean): void {
    this.on = on;
    this.sync();
  }

  /** Whether the first-run sheet has been accepted (`MEETING_CONSENT_KEY`). */
  setConsented(consented: boolean): void {
    this.consented = consented;
    this.sync();
  }

  private sync(): void {
    const wanted = this.on && this.consented;
    if (wanted === this.live) return;
    if (wanted) this.returns = ASSISTANT_CHORDS.map(({ key, action }) => this.deps.register(key, () => this.press(action)));
    else for (const give of this.returns.splice(0)) give();
  }

  press(action: AssistantAction): void {
    const { panel } = this.deps;
    switch (action) {
      case "toggle":
        if (panel.isOpen() && this.deps.shown()) { panel.close(); return; }
        panel.openInactive();
        this.deps.send(action);
        return;
      case "listen":
        if (!this.deps.listening()) panel.openInactive();
        this.deps.send(action);
        return;
      case "answer":
        panel.openInactive();
        this.deps.send(action);
        return;
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

  /** The quick chat keys (its chord, a double-tap of Command): the panel on the chat, with the
   *  keyboard, or put away when the chat is what it shows. */
  openChat(): void {
    const { panel } = this.deps;
    if (panel.isOpen() && !this.deps.shown()) { panel.close(); return; }
    panel.open();
    this.deps.send("chat");
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

  /** The page is reloading or has crashed: keys wait again until it says it listens. */
  forget(page: P): void {
    if (this.ready === page) this.ready = null;
  }
}

/** Runs `gone` each time the page starts loading a new document in its main frame, or crashes. */
export function onPageGone(page: Pick<ListeningPage, "on">, gone: () => void): void {
  page.on("render-process-gone", gone);
  page.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) gone(); });
}
