import { useSyncExternalStore } from "react";
import type { HLJSApi } from "highlight.js";
import type Katex from "katex";

/**
 * KaTeX and highlight.js, kept out of the boot chunk.
 *
 * Together they are about 400 KB of minified script that no window needs before it first paints,
 * and most windows open on a transcript long after the app is up. `preloadRichLibs` fetches them
 * once the window is idle; a render that needs one before then draws its plain fallback (escaped
 * code, the TeX source) and asks for them, and every subscriber of `useRichLibs` re-renders when
 * they land. Rendering stays synchronous: the libraries are either here or the text is drawn as
 * text, never a promise in the middle of a render.
 */
let katex: typeof Katex | null = null;
let hljs: HLJSApi | null = null;
let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();

export function loadRichLibs(): Promise<void> {
  loading ??= Promise.all([import("./katex-lib"), import("./highlight-grammars")]).then(
    ([k, h]) => {
      katex = k.default;
      hljs = h.default;
      version += 1;
      for (const listener of listeners) listener();
    },
    (err: unknown) => {
      // A chunk that failed to load is asked for again by the next render that needs it.
      loading = null;
      throw err;
    },
  );
  return loading;
}

const request = (): void => { loadRichLibs().catch(() => {}); };

/** KaTeX if it has loaded; otherwise null, and the load is started. */
export function katexIfLoaded(): typeof Katex | null {
  if (!katex) request();
  return katex;
}

/** highlight.js with every grammar registered, if it has loaded; otherwise null, and the load is started. */
export function hljsIfLoaded(): HLJSApi | null {
  if (!hljs) request();
  return hljs;
}

/** Fetch both once the window has nothing better to do, so the first transcript finds them here. */
export function preloadRichLibs(): void {
  const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1));
  idle(request);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = (): number => version;

/** A number that changes when the libraries land: put it in the deps of anything that renders with them. */
export function useRichLibs(): number {
  return useSyncExternalStore(subscribe, snapshot);
}
