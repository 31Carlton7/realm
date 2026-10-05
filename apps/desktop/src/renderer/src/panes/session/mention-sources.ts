import { MAC_SKILL_ID, basenameOf, documentKindFor, fileLabelCandidates, isImageMime, isSecretPath, matchPath, mimeForPath, type InstalledApp, type LibraryEntry, type Skill, type UnlabelledRef } from "@realm/contracts";
import type { IconName } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The prompter's one `@` list: files in the session's workspace, the Library, skills, the apps on
 * this Mac, and @Mac — the `mac` skill, which drives this Mac's own apps.
 *
 * Two shapes, by whether anything has been typed. A bare `@` is a short tour in a fixed order, each
 * kind under a quiet head, a few of each: nothing has been asked yet, so the list says what CAN be
 * named. A word after the `@` is a question, and the answer is ONE list ranked across every kind —
 * the best match is the first row, whatever it is, so Enter takes it. Each row then says what kind
 * of thing it is, since the heads are gone.
 *
 * The scorer is ⌘P's (`matchPath`), for every kind: an app's name and a skill's id are scored as a
 * file's name is, so the four kinds' numbers are one scale and can be merged rather than stacked.
 */

export type MentionOption =
  | { kind: "mac"; key: string; name: string; skill: Skill }
  | { kind: "skill"; key: string; name: string; skill: Skill }
  | { kind: "file"; key: string; name: string; rel: string; path: string }
  | { kind: "library"; key: string; name: string; path: string; from: string }
  | { kind: "app"; key: string; name: string; app: InstalledApp };

/** One row as the picker draws it: the option, the quiet line after its name, and — in the tour —
 *  the head of the group it opens. */
export type MentionRow = MentionOption & { detail: string; head?: string };

/** A file hit from the server, by its path in the checkout. */
export type FileHit = { path: string };

/** How many of each kind the tour shows. A bare `@` is a sample, not an inventory: typing is how
 *  the rest is reached, and a tour longer than the popover hides its last group behind a scroll. */
export const TOUR_CAPS = { file: 4, library: 3, skill: 5, app: 5 } as const;
/** How many of each kind a typed answer may hold, so one kind with a thousand weak matches (files,
 *  on one letter) cannot push every other kind off the list. */
export const RANKED_CAPS = { mac: 1, skill: 4, app: 6, file: 6, library: 4 } as const;
/** The order kinds break ties in — the special row, then what names a capability, then data. */
const KIND_ORDER: Record<MentionOption["kind"], number> = { mac: 0, skill: 1, app: 2, file: 3, library: 4 };

/** What @Mac says about itself in the list. */
export const MAC_DETAIL = "Calendar, Reminders, Contacts and more on this Mac";

const TYPE_LABEL: Record<MentionOption["kind"], string> = { mac: "Skill", skill: "Skill", file: "File", library: "Library", app: "Computer use" };

/** The glyph a named file wears — what kind of file, at a glance. */
export function fileMark(path: string): IconName {
  if (isImageMime(mimeForPath(path))) return "image";
  const kind = documentKindFor(path);
  return kind === "code" ? "code" : kind === "sheet" ? "table" : "artifact";
}

const dirOf = (rel: string): string => { const cut = rel.lastIndexOf("/"); return cut === -1 ? "" : rel.slice(0, cut); };

/** Every option this session could name, unranked — the sources joined, and nothing listed twice. */
export function mentionOptions(src: { mac: Skill | null; skills: readonly Skill[]; files: readonly FileHit[]; cwd: string; library: readonly LibraryEntry[]; apps: readonly InstalledApp[] }): MentionOption[] {
  const root = src.cwd.replace(/\/+$/, "");
  const files: MentionOption[] = src.files.filter((f) => !isSecretPath(f.path)).map((f) => ({ kind: "file", key: `file:${f.path}`, name: basenameOf(f.path), rel: f.path, path: `${root}/${f.path}` }));
  const filePaths = new Set(files.map((f) => (f as Extract<MentionOption, { kind: "file" }>).path));
  // A Library file that is also in this checkout is the same file: it is listed once, as the file —
  // where it is beats where it came from. A relative path names nothing a mention could hand over.
  const library: MentionOption[] = src.library
    .filter((e) => e.path.startsWith("/") && !isSecretPath(e.path) && !filePaths.has(e.path))
    .filter((e, i, all) => all.findIndex((x) => x.path === e.path) === i)
    .map((e) => ({ kind: "library", key: `library:${e.path}`, name: e.name, path: e.path, from: e.kind === "added" ? "Added by you" : e.sessionTitle ?? "" }));
  return [
    ...(src.mac ? [{ kind: "mac", key: "mac", name: MAC_SKILL_ID, skill: src.mac } as MentionOption] : []),
    ...files,
    ...library,
    // @Mac is the `mac` skill; it is listed once, as itself.
    ...src.skills.filter((s) => s.id !== MAC_SKILL_ID).map((s): MentionOption => ({ kind: "skill", key: `skill:${s.id}`, name: s.id, skill: s })),
    ...src.apps.map((a): MentionOption => ({ kind: "app", key: `app:${a.bundleId}`, name: a.name, app: a })),
  ];
}

/**
 * The best score any of an option's names earns against `query`, and the length of the name that
 * earned it — or null when none matches.
 *
 * Scored twice, as typed and folded to lowercase, keeping the better: ⌘P's ranker gives a point for
 * agreeing in case, which is right inside one list of paths and wrong across kinds — "mes" must not
 * prefer `messages-export.csv` to Messages because the app's name is capitalised. Folding alone
 * would lose a camel hump's boundary (`DocumentsPane`), which is why the typed form is kept too.
 */
export function scoreOption(o: MentionOption, query: string): { score: number; len: number } | null {
  const names = o.kind === "file" ? [o.rel]
    : o.kind === "app" ? [o.name, ...o.app.aliases]
    : o.kind === "skill" ? [o.skill.id, o.skill.name]
    : o.kind === "mac" ? [MAC_SKILL_ID, "macOS"]
    : [o.name];
  const q = query.toLowerCase();
  let best: { score: number; len: number } | null = null;
  for (const n of names) {
    const typed = matchPath(n, query)?.score ?? -Infinity;
    const folded = matchPath(n.toLowerCase(), q)?.score ?? -Infinity;
    const score = Math.max(typed, folded);
    if (score === -Infinity) continue;
    // The file's NAME is what a person reads, so a path's length is not held against it.
    const len = o.kind === "file" ? o.name.length : n.length;
    if (!best || score > best.score || (score === best.score && len < best.len)) best = { score, len };
  }
  return best;
}

/** The quiet line after a row's name. In the tour the head already says the kind, so only the
 *  detail is shown; in a ranked answer the kind leads. */
function detailOf(o: MentionOption, ranked: boolean, accessibility: boolean | null): string {
  const detail = o.kind === "file" ? dirOf(o.rel)
    : o.kind === "library" ? o.from
    : o.kind === "skill" ? (o.skill.name !== o.skill.id ? `${o.skill.name} — ${o.skill.description}` : o.skill.description)
    : o.kind === "mac" ? MAC_DETAIL
    // What the mention does to an app, and — said, not hidden — when macOS has not let it happen.
    : accessibility === false ? "needs Accessibility" : "";
  if (o.kind === "app") return detail ? `${TYPE_LABEL.app} · ${detail}` : TYPE_LABEL.app;
  if (!ranked) return detail;
  return detail ? `${TYPE_LABEL[o.kind]} · ${detail}` : TYPE_LABEL[o.kind];
}

const HEAD: Record<Exclude<MentionOption["kind"], "mac">, string> = { file: "Files", library: "Library", skill: "Skills", app: "Apps" };

/**
 * The rows for a query, in the order shown.
 *
 * Empty: @Mac first, on its own — the one row that is not one of many — then each kind under its
 * head in a fixed order, a few of each: files as the checkout lists them, the Library newest first,
 * skills as the library sorts them, apps in the Dock's order and then by name.
 *
 * Typed: every option that matches, capped per kind, then ranked as one list by score; a tie goes to
 * the shorter of the names that matched — `Code` the alias over "Code review" — then to the kind that
 * names a capability, then alphabetically: a total order, so equal rows never trade places between
 * keystrokes.
 */
export function mentionRows(options: readonly MentionOption[], query: string, opts: { accessibility?: boolean | null } = {}): MentionRow[] {
  const q = query.trim();
  const a11y = opts.accessibility ?? null;
  if (q === "") {
    const out: MentionRow[] = [];
    const mac = options.find((o) => o.kind === "mac");
    if (mac) out.push({ ...mac, detail: detailOf(mac, false, a11y) });
    for (const kind of ["file", "library", "skill", "app"] as const) {
      let group = options.filter((o) => o.kind === kind);
      if (kind === "app") {
        group = [...group].sort((x, y) => {
          const dx = (x as Extract<MentionOption, { kind: "app" }>).app.dock, dy = (y as Extract<MentionOption, { kind: "app" }>).app.dock;
          return (dx ?? Infinity) - (dy ?? Infinity) || x.name.localeCompare(y.name, undefined, { sensitivity: "base" });
        });
      }
      group.slice(0, TOUR_CAPS[kind]).forEach((o, i) => out.push({ ...o, detail: detailOf(o, false, a11y), ...(i === 0 ? { head: HEAD[kind] } : {}) }));
    }
    return out;
  }
  const scored: { o: MentionOption; score: number; len: number }[] = [];
  const order = (x: { o: MentionOption; score: number; len: number }, y: { o: MentionOption; score: number; len: number }) =>
    y.score - x.score || x.len - y.len || KIND_ORDER[x.o.kind] - KIND_ORDER[y.o.kind] || (x.o.name < y.o.name ? -1 : x.o.name > y.o.name ? 1 : 0);
  for (const kind of ["mac", "skill", "app", "file", "library"] as const) {
    const hits = options.filter((o) => o.kind === kind).flatMap((o) => { const s = scoreOption(o, q); return s === null ? [] : [{ o, ...s }]; });
    hits.sort(order);
    scored.push(...hits.slice(0, RANKED_CAPS[kind]));
  }
  scored.sort(order);
  return scored.map(({ o }) => ({ ...o, detail: detailOf(o, true, a11y) }));
}

/** What a picked option becomes in the draft's sidecar — null for the two that are plain `@id`s. */
export function refFor(o: MentionOption): UnlabelledRef | null {
  if (o.kind === "file") return { kind: "file", path: o.path };
  if (o.kind === "library") return { kind: "library", path: o.path };
  if (o.kind === "app") return { kind: "app", name: o.app.name, bundleId: o.app.bundleId, path: o.app.path };
  return null;
}

/** The label candidates a picked option offers, best first (`mentionRefLabel` takes the first free). */
export function labelCandidatesFor(o: MentionOption): string[] {
  return o.kind === "file" ? fileLabelCandidates(o.rel) : [o.name];
}

/**
 * Everything the `@` list reads that the Composer does not own, handed in by the session pane — the
 * store's caches and the two sources that answer a query over the wire.
 */
export type MentionSources = {
  /** The session's working directory: file hits are relative to it, and their refs are absolute. */
  cwd: string;
  /** The `mac` skill, when the space's library has it — the @Mac row. */
  mac: Skill | null;
  /** The apps on this Mac, or null before main has been asked. */
  apps: readonly InstalledApp[] | null;
  /** App icons by bundle path, as far as they have been fetched. */
  appIcons: Readonly<Record<string, string | null>>;
  /** Whether macOS lets Realm drive other apps: null until asked. */
  accessibility: boolean | null;
  /** The checkout's files ranked against `query` (the server's `mentions.files`). */
  files(query: string): Promise<FileHit[]>;
  /** The Library's files whose names contain `query`, newest first. */
  library(query: string): Promise<LibraryEntry[]>;
  /** The list opened: load what it lists (the apps, the Accessibility state). Cheap to repeat. */
  onOpen(): void;
  /** Fetch these apps' icons, if they are not fetched already. */
  ensureIcons(paths: readonly string[]): void;
};

/**
 * The two answers that come over the wire, for the query being typed — the checkout's files and the
 * Library's — kept while the next answer is on its way, but narrowed at once to what still matches,
 * so a row the new query rules out never lingers for a round trip. An answer that arrives after a
 * newer one was asked for is dropped.
 */
export function useMentionAnswers(src: MentionSources | undefined, query: string | null): { files: FileHit[]; library: LibraryEntry[] } {
  const [answer, setAnswer] = useState<{ files: FileHit[]; library: LibraryEntry[] }>({ files: [], library: [] });
  const asked = useRef(0);
  const open = query !== null;
  // Keyed on the source's FUNCTIONS, which the pane holds still, never on the object: it is rebuilt
  // whenever an icon arrives, and a fetch keyed on it would ask the server again for every icon.
  const onOpen = src?.onOpen, files = src?.files, library = src?.library;
  useEffect(() => { if (open) onOpen?.(); }, [open, onOpen]);
  useEffect(() => {
    if (!files || !library || query === null) return;
    const n = ++asked.current;
    let live = true;
    void Promise.all([files(query).catch(() => [] as FileHit[]), library(query).catch(() => [] as LibraryEntry[])])
      .then(([f, l]) => { if (live && n === asked.current) setAnswer({ files: f, library: l }); });
    return () => { live = false; };
  }, [files, library, query]);
  return useMemo(() => {
    if (!query?.trim()) return answer;
    const q = query.trim();
    return { files: answer.files.filter((f) => matchPath(f.path, q)), library: answer.library.filter((e) => matchPath(e.name, q)) };
  }, [answer, query]);
}
