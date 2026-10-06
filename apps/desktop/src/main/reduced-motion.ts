import { isReducedMotionPref, reducedMotionFeature } from "@realm/contracts";

/** The part of a WebContents this needs, so a test can stand in for one. */
export type MotionTarget = {
  isDestroyed(): boolean;
  debugger: { isAttached(): boolean; attach(protocolVersion?: string): void; sendCommand(method: string, params?: object): Promise<unknown> };
};

/**
 * Make a window report the user's reduced-motion preference as the system's.
 *
 * The stylesheet's motion rules hang off `@media (prefers-reduced-motion: reduce)` and the few
 * frame-driven surfaces ask `matchMedia` the same question, so the one way to override them all — and
 * to have them all agree — is to change the answer to the question rather than to add a second one.
 * Chromium will do that for its own DevTools (`Emulation.setEmulatedMedia`), and Electron hands the
 * same protocol to main as `webContents.debugger`. The session is the one the app-drive host already
 * opens on this window, shared by `isAttached()` and never detached, and an emulation set on it lasts
 * as long as the window does, reloads included.
 *
 * "System" is the absence of an override: with nothing attached there is nothing to lift, so it
 * costs no session at all, which is what every window that never had a preference gets.
 */
export async function applyReducedMotion(target: MotionTarget, pref: unknown): Promise<void> {
  if (!isReducedMotionPref(pref) || target.isDestroyed()) return;
  const session = target.debugger;
  if (pref === "system" && !session.isAttached()) return;
  if (!session.isAttached()) session.attach("1.3");
  await session.sendCommand("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: reducedMotionFeature(pref) }],
  });
}
