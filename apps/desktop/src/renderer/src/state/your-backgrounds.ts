import { useEffect, useSyncExternalStore } from "react";
import type { BackgroundImage, BackgroundsAdded } from "@realm/contracts";

/**
 * The person's own backgrounds, as main keeps them (main/backgrounds.ts), shared by every session
 * pane and the picker in Settings. Loaded on first use; undefined until main has answered, and
 * empty where there is no bridge.
 */
let images: BackgroundImage[] | undefined;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const urls = new Map<string, Promise<string | null>>();

const bridge = () => window.realm?.backgrounds;
const publish = (next: BackgroundImage[]) => { images = next; listeners.forEach((l) => l()); };

function refreshYourBackgrounds(): Promise<void> {
  const b = bridge();
  loading = (b ? b.list().catch(() => []) : Promise.resolve([])).then(publish);
  return loading;
}

export function useYourBackgrounds(): BackgroundImage[] | undefined {
  const value = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => images);
  useEffect(() => { if (!images && !loading) void refreshYourBackgrounds(); }, []);
  return value;
}

async function adding(run: () => Promise<BackgroundsAdded> | undefined): Promise<BackgroundsAdded> {
  const result = (await run()) ?? { added: [], refused: [] };
  if (result.added.length) publish([...(images ?? []), ...result.added]);
  return result;
}

export const pickYourBackgrounds = () => adding(() => bridge()?.pick());
export const addYourBackgrounds = (paths: string[]) => adding(() => bridge()?.add(paths));

export async function updateYourBackground(id: string, patch: Partial<Pick<BackgroundImage, "name" | "effect" | "asIs">>): Promise<void> {
  const next = await bridge()?.update(id, patch);
  if (next) publish((images ?? []).map((m) => (m.id === id ? next : m)));
}

export async function removeYourBackground(id: string): Promise<void> {
  if (!(await bridge()?.remove(id))) return;
  for (const size of ["thumb", "full"]) urls.delete(`${id}:${size}`);
  publish((images ?? []).filter((m) => m.id !== id));
}

/** A kept picture's data: URL, asked of main once per picture and size. */
export function yourBackgroundUrl(id: string, size: "thumb" | "full"): Promise<string | null> {
  const key = `${id}:${size}`;
  let hit = urls.get(key);
  if (!hit) {
    hit = bridge()?.image(id, size).catch(() => null) ?? Promise.resolve(null);
    urls.set(key, hit);
  }
  return hit;
}

/** For tests: forget everything, as a fresh window would. */
export function resetYourBackgrounds() { images = undefined; loading = null; urls.clear(); }
