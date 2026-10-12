import { createElement, type ComponentType } from "react";

/**
 * A component whose code is its own chunk, for the parts of the app nobody needs before the window
 * is up: Settings, code review, the runner on a browser's error page, the Realmite maker.
 *
 * Not `React.lazy`, for one reason: `React.lazy` suspends on its first render even when the chunk is
 * already here, so a pane opened after the chunk was preloaded would still flash its fallback for a
 * frame. This one renders the component in the same pass once `preload` has resolved, and only
 * suspends (to the nearest `<Suspense>`) when it really is still loading.
 *
 * Every one made is preloaded by `preloadLazyComponents`, which the window calls once it is idle, so
 * the fallback is a thing a person sees only when they open one of these within the first moments.
 */
const preloads: (() => Promise<void>)[] = [];

export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> & { preload: () => Promise<void> } {
  let loaded: ComponentType<P> | null = null;
  let failed: unknown = null;
  let pending: Promise<void> | null = null;
  const preload = (): Promise<void> => (pending ??= load().then(
    (c) => { loaded = c; failed = null; },
    (e: unknown) => { failed = e; pending = null; },
  ));
  function Lazy(props: P) {
    if (loaded) return createElement(loaded, props);
    // A chunk that failed is an error for the nearest boundary, not a promise to wait on forever.
    if (failed) { const e = failed; failed = null; throw e; }
    throw preload();
  }
  preloads.push(preload);
  return Object.assign(Lazy, { preload });
}

/** Every lazy component's chunk, now. */
export function loadLazyComponents(): Promise<void> {
  return Promise.all(preloads.map((preload) => preload())).then(() => {});
}

/** Fetch every lazy component's chunk once the window has nothing better to do. */
export function preloadLazyComponents(): void {
  const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1));
  idle(() => void loadLazyComponents(), { timeout: 5000 });
}
