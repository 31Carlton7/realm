/**
 * The menu-bar item that exists whenever Realm's window does not.
 *
 * It is the only visible thing left after ⌘Q, which makes it the answer to two questions a person is
 * entitled to ask: is anything still running, and how do I stop it. Both are answered in words —
 * per design.md, where a glyph would be one more unexplained icon in a menu bar full of them, and
 * where "3 working" said plainly beats any badge.
 *
 * `trayTitle` and `trayMenu` are pure descriptors so both are testable without a menu bar, the same
 * split `computer-driving.ts` uses for the same reason.
 */
import type { MenuItemConstructorOptions } from "electron";

/** The part of Electron's `Tray` this needs. */
export type SessionTrayHandle = {
  setTitle(title: string): void;
  setToolTip(tip: string): void;
  setContextMenu(template: MenuItemConstructorOptions[]): void;
  destroy(): void;
};

export type TrayCounts = { working: number; needsYou: number };
export type TraySession = { id: string; spaceId: string | null; title: string; spaceName: string | null };

/** How many session titles the menu lists before it stops. A menu long enough to scroll is a menu
 *  that has stopped being a summary. */
export const TRAY_SESSION_LIMIT = 5;

/**
 * The text beside the icon.
 *
 * Empty when nothing is working: where the owner has said nothing, show nothing. A permanent "0" or
 * a permanent dot would occupy menu-bar width to report the absence of news, and — because every item
 * to the left shifts when one appears — would make the rest of the menu bar move for no reason.
 */
export function trayTitle(counts: TrayCounts): string {
  if (counts.needsYou > 0) return `${counts.needsYou} waiting`;
  if (counts.working > 0) return String(counts.working);
  return "";
}

export function trayTooltip(counts: TrayCounts): string {
  if (counts.needsYou > 0) return `Realm — ${counts.needsYou} ${counts.needsYou === 1 ? "session needs" : "sessions need"} an answer`;
  if (counts.working > 0) return `Realm — ${counts.working} ${counts.working === 1 ? "session is" : "sessions are"} working`;
  return "Realm — nothing running";
}

/** The header line, which is the whole status in one phrase. */
export function trayHeader(counts: TrayCounts): string {
  if (counts.needsYou > 0 && counts.working > 0) return `${counts.working} working, ${counts.needsYou} waiting on you`;
  if (counts.needsYou > 0) return `${counts.needsYou} ${counts.needsYou === 1 ? "session needs" : "sessions need"} an answer`;
  if (counts.working > 0) return `${counts.working} ${counts.working === 1 ? "session" : "sessions"} working`;
  return "Nothing running";
}

export type TrayActions = {
  /** Bring the window back, optionally landing on one session. The space rides along because that is
   *  what the renderer needs to reveal a session that is not in the space currently open. */
  reattach: (target?: { sessionId: string; spaceId: string | null }) => void;
  stopAllAgents: () => void;
  quitAndStop: () => void;
};

/** The menu, as a template. Pure: it reads counts and sessions and produces a description, so a test
 *  can assert over labels and enabled-ness without a menu bar to click. */
export function trayMenu(d: { counts: TrayCounts; sessions: TraySession[]; actions: TrayActions }): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: trayHeader(d.counts), enabled: false },
    { type: "separator" },
  ];
  for (const s of d.sessions.slice(0, TRAY_SESSION_LIMIT)) {
    items.push({
      // The space name is here because at this point the window is closed and a title alone does not
      // say which of three spaces to open.
      label: s.spaceName ? `${s.title} — ${s.spaceName}` : s.title,
      click: () => d.actions.reattach({ sessionId: s.id, spaceId: s.spaceId }),
    });
  }
  if (d.sessions.length > 0) items.push({ type: "separator" });
  items.push({ label: "Open Realm", click: () => d.actions.reattach() });
  items.push({
    label: "Stop all agents",
    enabled: d.counts.working > 0,
    click: () => d.actions.stopAllAgents(),
  });
  items.push({ type: "separator" });
  items.push({ label: "Quit Realm & stop agents", click: () => d.actions.quitAndStop() });
  return items;
}

/** Owns the item's existence: up whenever there is no window, gone whenever there is one. */
export class SessionTray {
  private tray: SessionTrayHandle | null = null;
  private counts: TrayCounts = { working: 0, needsYou: 0 };
  private sessions: TraySession[] = [];

  constructor(private readonly d: { createTray: () => SessionTrayHandle; actions: TrayActions }) {}

  get showing(): boolean {
    return this.tray !== null;
  }

  /** Put the item up. Called the instant the last window closes, never lazily on the first event —
   *  a person who has just quit and has agents running must see something immediately. */
  show(): void {
    if (!this.tray) this.tray = this.d.createTray();
    this.render();
  }

  hide(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  update(counts: TrayCounts, sessions: TraySession[]): void {
    this.counts = counts;
    this.sessions = sessions;
    if (this.tray) this.render();
  }

  private render(): void {
    const tray = this.tray;
    if (!tray) return;
    tray.setTitle(trayTitle(this.counts));
    tray.setToolTip(trayTooltip(this.counts));
    tray.setContextMenu(trayMenu({ counts: this.counts, sessions: this.sessions, actions: this.d.actions }));
  }
}
