import { useEffect, useState } from "react";
import { MAX_MEDIA_CANDIDATES, type MediaFile } from "@realm/contracts";

/**
 * Resolving guessed paths to real files, once per path for the life of the window.
 *
 * A transcript re-renders constantly — every delta of a streaming message re-runs the block that
 * asks about its media — so the ask has to be idempotent and cheap. Two module-level maps do that:
 * `resolved` holds what main answered for a path (a `MediaFile`, or `null` for "not media, or not
 * there"), `inflight` collapses concurrent asks for the same path into one round trip.
 *
 * A negative answer is cached exactly as hard as a positive one. Most candidates are wrong by
 * construction — they are joins of a filename against every directory a message mentioned — and a
 * miss that is re-asked on every render would turn one bad guess into a stat storm.
 */
const resolved = new Map<string, MediaFile | null>();
const inflight = new Map<string, Promise<void>>();

/** Test seam and cache reset. Nothing in the app calls this; the suite does, between cases that
 *  would otherwise see each other's answers. */
export function resetMediaCache(): void {
  resolved.clear();
  inflight.clear();
}

async function ask(paths: string[]): Promise<void> {
  const answers = (await window.realm?.media?.stat(paths).catch(() => [])) ?? [];
  for (const [i, path] of paths.entries()) {
    // Positional: main answers with the RESOLVED path (`~` expanded, `..` collapsed), which is
    // generally not the string that was asked about, so index is the only reliable join.
    const file = answers[i] ?? null;
    resolved.set(path, file);
    // Cache under the canonical path too — the same file reached by two spellings is one file, and
    // both the strip and the lightbox look it up by the one main gave back.
    if (file) resolved.set(file.path, file);
  }
}

/** Puts the unanswered candidates to main and re-renders when they come back. Everything below is a
 *  different reading of the same cache; this is the only thing that fills it. */
function useResolveMedia(candidates: readonly string[]): void {
  // The key is what the effect depends on: a stable string, so a caller that rebuilds its candidate
  // array on every render (all of them do — it is derived from the message text) does not re-ask.
  const key = candidates.join("\n");
  const [, bump] = useState(0);
  useEffect(() => {
    if (candidates.length === 0) return;
    const open = candidates.filter((p) => !resolved.has(p));
    const unknown = open.filter((p) => !inflight.has(p)).slice(0, MAX_MEDIA_CANDIDATES);
    /* A path already in flight was asked by another reader, and that answer is this reader's too —
       so it waits on that ask rather than skipping the path. Skipping is what held the file
       browser's lightbox on its fallback preview for good: the preview is the lightbox's CHILD,
       children's effects run before their parent's, so the preview asked first, and the lightbox
       found the path in flight, asked nothing, and was never told the answer had come. */
    const waits = new Set(open.flatMap((p) => inflight.get(p) ?? []));
    if (unknown.length > 0) {
      const p = ask(unknown).finally(() => { for (const path of unknown) inflight.delete(path); });
      for (const path of unknown) inflight.set(path, p);
      waits.add(p);
    }
    if (waits.size === 0) return;
    let live = true;
    void Promise.allSettled(waits).then(() => { if (live) bump((n) => n + 1); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` IS the candidate list, stably
  }, [key]);
}

/**
 * The files behind `candidates`, keyed by the CANDIDATE — the string the caller asked with, not the
 * resolved path main answered.
 *
 * That distinction is the whole reason this exists beside `useMediaFiles`. A caller that has to put
 * a player back where a particular `~/out/clip.mp4` appeared in a sentence cannot look it up by
 * `/Users/me/out/clip.mp4`, and joining on the wrong one silently drops every embed written with a
 * `~`.
 */
export function useMediaByCandidate(candidates: readonly string[]): Map<string, MediaFile> {
  useResolveMedia(candidates);
  const out = new Map<string, MediaFile>();
  for (const c of candidates) {
    const file = resolved.get(c);
    if (file) out.set(c, file);
  }
  return out;
}

/**
 * The subset of `candidates` that are real media files on disk, in the order they were given, with
 * duplicates collapsed — two spellings of one file are one file to show.
 *
 * Returns `[]` on the first render and again for a message with nothing to show — a caller that
 * cannot tell those apart is a caller that would flash an empty strip, so nothing is drawn for an
 * empty array either way.
 */
export function useMediaFiles(candidates: readonly string[]): MediaFile[] {
  const byCandidate = useMediaByCandidate(candidates);
  const out: MediaFile[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const file = byCandidate.get(c);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}

/** A video's poster frame, cached the same way and for the same reason. Null until QuickLook
 *  answers, and null forever for a file it cannot render — the player draws its own placeholder,
 *  and the first decoded frame replaces it regardless. */
const posters = new Map<string, string | null>();
const posterInflight = new Map<string, Promise<string | null>>();

export function usePoster(path: string | null): string | null {
  const [poster, setPoster] = useState<string | null>(() => (path ? posters.get(path) ?? null : null));
  useEffect(() => {
    if (!path) { setPoster(null); return; }
    if (posters.has(path)) { setPoster(posters.get(path) ?? null); return; }
    let live = true;
    const p = posterInflight.get(path) ?? (window.realm?.media?.poster(path) ?? Promise.resolve(null))
      .catch(() => null)
      .then((url) => { posters.set(path, url); posterInflight.delete(path); return url; });
    posterInflight.set(path, p);
    void p.then((url) => { if (live) setPoster(url); });
    return () => { live = false; };
  }, [path]);
  return poster;
}
