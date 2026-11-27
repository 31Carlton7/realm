/** Who asked for a window to come forward: the person, with a click or a key, or an agent, through a
 *  tool such as `space_switch`. */
export type RaiseBy = "person" | "agent";

export const raiseBy = (v: unknown): RaiseBy => (v === "agent" ? "agent" : "person");

type Raisable = { isMinimized(): boolean; restore(): void; show(): void; focus(): void };

/**
 * Raise a window in front of everything, the app included, when the person asked. An agent's request
 * never activates Realm: with Realm already the app in front the window comes up inside it, and with
 * another app in front nothing moves, so whatever the person is typing into keeps the keyboard. The
 * window still shows what was asked for when they come back to Realm.
 */
export function bringForward(win: Raisable, by: RaiseBy, d: { appActive: boolean; activateApp: () => void }): void {
  if (by === "agent" && !d.appActive) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (by === "person") d.activateApp();
}
