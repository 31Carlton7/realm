import { useEffect } from "react";
import { useApp, useAppStore, type AppState } from "../../state/store";

/** The spaces of the window's profile it has not read yet, the one used most recently first: by the
 *  newest activity of any session in it, then by rail order. */
export function spacesToRead(s: AppState): string[] {
  const usedAt = new Map<string, number>();
  for (const [id, sid] of Object.entries(s.sessionSpace)) usedAt.set(sid, Math.max(usedAt.get(sid) ?? 0, s.sessionActivityAt[id] ?? 0));
  return s.spaces.filter((sp) => sp.profileId === s.activeProfileId && !s.heldSpaces.includes(sp.id))
    .sort((a, b) => (usedAt.get(b.id) ?? 0) - (usedAt.get(a.id) ?? 0) || a.sortOrder - b.sortOrder)
    .map((sp) => sp.id);
}

const idle = (): Promise<void> => new Promise((go) => {
  if (globalThis.requestIdleCallback) globalThis.requestIdleCallback(() => go(), { timeout: 1000 });
  else setTimeout(go, 1);
});

/**
 * Once the window's own space is up, read the profile's other spaces in the background, one at a
 * time and the most recently used first, so the first switch into one finds it read. Boot reads only
 * the space it lands in; this keeps the rest off its path.
 */
export function useWarmSpaces(): void {
  const store = useAppStore();
  const profileId = useApp((s) => s.activeProfileId);
  const ready = useApp((s) => s.booted && !!s.activeSpaceId && s.heldSpaces.includes(s.activeSpaceId));
  useEffect(() => {
    if (!ready || !profileId) return;
    let stopped = false;
    // A read that failed is not asked again by this pass, or it would be asked forever.
    const tried = new Set<string>();
    void (async () => {
      for (;;) {
        await idle();
        if (stopped) return;
        const next = spacesToRead(store.getState()).find((sid) => !tried.has(sid));
        if (!next) return;
        tried.add(next);
        await store.getState().readSpace(next).catch(() => {});
      }
    })();
    return () => { stopped = true; };
  }, [ready, profileId, store]);
}
