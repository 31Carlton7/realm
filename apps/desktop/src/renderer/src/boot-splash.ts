/**
 * Take down the boot mark in `index.html`.
 *
 * The mark covers the gap between the window appearing and Realm having anything to show. That gap
 * is NOT "until React mounts": `App` mounts and then awaits `boot()`, so mounting early would hand
 * the reader the same empty window the mark exists to cover, a few hundred milliseconds sooner. The
 * honest signal is the store's `booted`, which is already what the onboarding sheet waits for so it
 * does not flash on every launch.
 *
 * Removed rather than hidden, and after its fade: it is a fixed, full-window layer, and one left in
 * the tree is a permanent invisible sheet over the app. `pointer-events: none` means a leak would
 * not swallow clicks, which is exactly what would keep it from ever being noticed.
 */

/** Matches the `boot-out` duration in `index.html`. */
const FADE_MS = 200;

let taken = false;

export function dismissBootSplash(doc: Document = document): void {
  if (taken) return;
  const el = doc.getElementById("boot");
  if (!el) { taken = true; return; }
  taken = true;
  el.setAttribute("data-done", "");
  // `remove()` on a timer rather than on `animationend`: a window that never composites — hidden,
  // occluded, or under `prefers-reduced-motion` with the animation cut to 1ms — may not fire the
  // event at all, and the node would stay forever.
  setTimeout(() => el.remove(), FADE_MS + 50);
}

/** Tests only: the module-level latch is what makes a second call a no-op. */
export function resetBootSplashForTests(): void { taken = false; }
