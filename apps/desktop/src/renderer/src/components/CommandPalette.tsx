import { Icon, THEMES, themeModes } from "@realm/ui";
import { AGENT_META, SELECTABLE_AGENT_KINDS, chordsForCommand, displayKeyChord, emptyLayout, itemIdOfLeaf, allItems as openItemIds, type DestinationPageKind, type Item, type KeyContext, type SearchResults, type SearchSnippet } from "@realm/contracts";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { StoreApi } from "zustand";
import { centerOverComplement } from "../state/no-overlay";
import { spaceIsPlainFolder, useApp, useBrowserRects, type AppState, type PaletteMode } from "../state/store";
import { closeIntent, type CloseIntent } from "../state/close-intent";
import { useResolvedMode, type ThemePref } from "../theme/useTheme";
import { ItemGlyph } from "./sidebar/ItemList";
import { ItemIcon } from "./PageIcon";
import { SpaceIcon } from "./SpaceIcon";
import { useDissolve } from "./ScrollFades";

type Entry = { id: string; label: string; hint?: ReactNode; icon: ReactNode; run: () => void; section: string; disabled?: boolean;
  /** A pre-rendered label, for a row whose match positions matter (a ⌘P path). `label` stays a plain
   *  string because it is what the instant filter scores against — two jobs, two fields. */
  display?: ReactNode;
  /** A deep-search row (Plan 16 W2): rendered below the instant rows, under its group header even
   *  while a query is typed (instant rows go flat with a query; these stay grouped). */
  deep?: boolean };

/** How long a keystroke rests before `search.query` goes out. The instant rows never wait on this —
 *  deep results only ever APPEND below them when the answer lands. */
export const SEARCH_DEBOUNCE_MS = 120;
/** One character matches everything and helps no one; deep search starts at two. */
export const SEARCH_MIN_QUERY = 2;

/** What the one palette calls itself in each of its narrowings. Without this the surface is
 *  byte-identical in both and a ⌘⇧P that landed in the wrong mode is indistinguishable from a ⌘⇧P
 *  that did nothing. */
export const PALETTE_PLACEHOLDER: Record<PaletteMode, string> = {
  all: "Search…",
  grep: "Find in files…",
};

function Snippet({ parts }: { parts: SearchSnippet }) {
  return <span className="palette-snippet">{parts.map((p, i) => p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</span>;
}

/** ⌘K toggles the palette. Bound separately from useGlobalHotkeys: it must fire while the palette
 *  itself is open (and its input focused), which the global guard forbids. */
export function usePaletteHotkey(store: StoreApi<AppState>) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = store.getState();
        if (s.sheet) return; // a modal sheet owns the keyboard
        s.setPaletteOpen(!s.paletteOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}

/**
 * Case-insensitive subsequence match with word-start / consecutive / prefix boosts (U-H6).
 * Null = no match. Higher scores sort first: "nt" scores "New terminal" (two word-starts) far above
 * "Open Terminal…" (one). Greedy left-to-right, so it is an approximation of the best alignment —
 * plenty for a palette.
 */
export function matchScore(query: string, text: string): number | null {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = -1, prev = -2;
  for (const ch of q) {
    ti = t.indexOf(ch, ti + 1);
    if (ti === -1) return null;
    if (ti === 0 || !/[a-z0-9]/.test(t[ti - 1]!)) score += 3; // word start
    else if (ti === prev + 1) score += 2;                      // consecutive run
    prev = ti;
  }
  if (t.startsWith(q)) score += 3;                             // whole-query prefix boost
  return score;
}

/** Compact relative age: "now", "5m", "2h", "3d", "2mo", "1y". */
export function relTime(ts: number, now = Date.now()): string {
  const m = Math.floor(Math.max(0, now - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

const MODES: ThemePref[] = ["system", "light", "dark"];

/** What the palette calls ⌘W where the keyboard is (`closeIntent`). A session alone has no entry:
 *  there is nothing to close, and a row whose whole effect is moving the caret is not a command. */
const CLOSE_LABEL: Record<CloseIntent["kind"], string | null> = {
  tab: "Close tab", unsplit: "Remove from split", empty: "Close the empty pane", pane: "Close pane", prompter: null,
};

/** The palette's CSS width (styles.css `.palette`); the no-overlay path needs the number. */
const PALETTE_WIDTH = 560;

/** The sidebar destinations, in the nav's own order, paired with the noun their entries read as
 *  ("Open library"). The kind doubles as the icon name — these pages own the icon of their kind. */
const DESTINATIONS: [DestinationPageKind, string][] = [
  ["library-page", "library"],
  ["connections-page", "connections"],
  ["code-review-page", "code review"],
  ["settings-page", "settings"],
];

/** How long the closing palette stays mounted. Must match `--dur-drag` in the stylesheet, which is
 *  what the exit animation runs for; a shorter value cuts the animation off mid-frame and a longer
 *  one leaves a finished, invisible dialog holding focus. */
export const PALETTE_EXIT_MS = 80;

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  /* Kept mounted through the exit. Unmounting on `open === false` is why this had no close animation
     to begin with — there was nothing left on screen to animate. */
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), PALETTE_EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return <PaletteBody closing={!open} />;
}

/** Search across every space's items (recency-sorted, disambiguated), plus actions and themes. */
function PaletteBody({ closing }: { closing: boolean }) {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  // A plain folder has no worktrees, so the palette offers no session in one (store.ts).
  const plainFolder = useApp((s) => (s.activeSpaceId ? spaceIsPlainFolder(s, s.activeSpaceId) : false));
  const items = useApp((s) => s.items);
  const allItems = useApp((s) => s.allItems);
  const layout = useApp((s) => s.layout);
  const focusedLeafId = useApp((s) => s.focusedLeafId);
  const sessions = useApp((s) => s.sessions);
  const sessionStatus = useApp((s) => s.sessionStatus);
  const themePref = useApp((s) => s.themePref);
  const themeNames = useApp((s) => s.themeNames);
  const mode = useResolvedMode(themePref);
  const setThemeName = useApp((s) => s.setThemeName);
  const selectSpace = useApp((s) => s.selectSpace);
  const revealItem = useApp((s) => s.revealItem);
  const newTerminal = useApp((s) => s.newTerminal);
  const newBrowser = useApp((s) => s.newBrowser);
  const newMachine = useApp((s) => s.newMachine);
  const newSimulator = useApp((s) => s.newSimulator);
  const newTab = useApp((s) => s.newTab);
  const showSessionTerminal = useApp((s) => s.showSessionTerminal);
  const openAgentsTab = useApp((s) => s.openAgentsTab);
  /* The session a side pane serves where the keyboard is — the one its tools open beside, as the
     side pane's "+" and ⌘P find it. */
  const besideSession = useApp((s) => { const owner = s.peekOwner(); const it = owner ? s.items.find((i) => i.id === owner) : undefined; return it?.kind === "session" ? it.refId : null; });
  const openDocuments = useApp((s) => s.openDocuments);
  const keybindings = useApp((s) => s.keybindings);
  /* A shortcut hint has to come from the same list the handler reads. Printing `⌘T` from a string
     literal was fine while the keymap was hardcoded; now that a user can rebind anything, a literal
     is a claim about their machine that Realm has no basis for. `chordsForCommand` returns only the
     chord whose WINNING rule is that command, so a binding a later rule defeated is never advertised.
     Nothing is shown when the command is unbound — an absent hint is honest, an invented one is not. */
  const kbd = useCallback((command: string) => {
    const chord = chordsForCommand(keybindings, command)[0];
    return chord ? <kbd>{displayKeyChord(chord)}</kbd> : undefined;
  }, [keybindings]);
  /* A chord whose rule asks for a context the empty one does not have — ⌘J needs a session in focus. */
  const kbdIn = useCallback((command: string, context: KeyContext) => {
    const chord = chordsForCommand(keybindings, command, context)[0];
    return chord ? <kbd>{displayKeyChord(chord)}</kbd> : undefined;
  }, [keybindings]);
  const paletteMode = useApp((s) => s.paletteMode);
  const searchProjectText = useApp((s) => s.searchProjectText);
  const openDocumentPath = useApp((s) => s.openDocumentPath);
  const newSession = useApp((s) => s.newSession);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const newSessionInWorktree = useApp((s) => s.newSessionInWorktree);
  const dispatchDraft = useApp((s) => s.dispatchDraft);
  const drafts = useApp((s) => s.drafts);
  const splitFocused = useApp((s) => s.splitFocused);
  /* Why a split from the focused pane is not offered, read as the palette opens: the room cannot change
     while it is up. */
  const splitWhyRow = useApp((s) => s.splitRefusal("row"));
  const splitWhyCol = useApp((s) => s.splitRefusal("col"));
  const closeInPane = useApp((s) => s.closeInPane);
  const requestRename = useApp((s) => s.requestRename);
  const interruptSession = useApp((s) => s.interruptSession);
  const jumpToPermission = useApp((s) => s.jumpToPermission);
  const zoomedLeaf = useApp((s) => s.view?.zoomedLeafId ?? null);
  const toggleFocusPane = useApp((s) => s.toggleFocusPane);
  const setThemePref = useApp((s) => s.setThemePref);
  const openSheet = useApp((s) => s.openSheet);
  const openSpacePage = useApp((s) => s.openSpacePage);
  const setSpacesOpen = useApp((s) => s.setSpacesOpen);
  const openDestinationPage = useApp((s) => s.openDestinationPage);
  const openProfilePage = useApp((s) => s.openProfilePage);
  const profiles = useApp((s) => s.profiles);
  const activeProfileId = useApp((s) => s.activeProfileId);
  const openProfileWindow = useApp((s) => s.openProfileWindow);
  const openNewProfileSheet = useApp((s) => s.openNewProfileSheet);
  const openActivity = useApp((s) => s.openActivity);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const refreshAllItems = useApp((s) => s.refreshAllItems);
  const searchDeep = useApp((s) => s.searchDeep);
  const run = useApp((s) => s.run);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useDissolve(listRef);
  const close = () => setPaletteOpen(false);
  // W2 (no-overlay): with a browser pane open, center over the widest non-browser column instead
  // of the window — the native view would paint over a window-centered palette. Computed inline
  // and applied as plain positioning (the palette is on the do-NOT-animate list; nothing tweens).
  const browserRects = useBrowserRects();
  const spot = centerOverComplement({ width: window.innerWidth, height: window.innerHeight }, browserRects, PALETTE_WIDTH);
  const paletteStyle = spot ? { position: "absolute" as const, left: spot.left, top: "12vh", width: spot.width } : undefined;

  // Cross-space listings come from items.listAll; refresh on every open so ages/titles are current.
  useEffect(() => { run(() => refreshAllItems()); }, [refreshAllItems, run]);

  // Deep search (Plan 16 W2): debounced and stale-guarded. THE instant-palette doctrine, restated
  // where it could be broken: nothing above this effect awaits it — the instant rows are computed
  // synchronously from state, and these results only ever append BELOW them when the answer lands.
  const [deep, setDeep] = useState<{ forQuery: string; results: SearchResults } | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);
  const deepQuery = query.trim();
  useEffect(() => {
    const seq = ++searchSeq.current;
    if (deepQuery.length < SEARCH_MIN_QUERY) { setDeep(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchDeep(deepQuery)
        .then((results) => {
          if (searchSeq.current !== seq) return; // a newer keystroke owns the pane now
          setDeep(results ? { forQuery: deepQuery, results } : null);
          setSearching(false);
        })
        .catch(() => { if (searchSeq.current === seq) { setDeep(null); setSearching(false); } });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [deepQuery, searchDeep]);

  /* ⌘⇧P: the same palette, narrowed to a checkout's contents. Debounced and stale-guarded with the
     same `searchSeq` the deep search uses, so a slow grep can never overwrite a newer keystroke's
     answer. Kept separate from `deep` rather than folded into it because this searches a DIRECTORY and
     that one searches Realm's records — this one can be null because there is no checkout, which is a
     different sentence from "no results". A file by its NAME is the documents pane's search (⌘P). */
  const [project, setProject] = useState<{ forQuery: string; rows: Entry[]; cwd: boolean } | null>(null);
  useEffect(() => {
    if (paletteMode === "all") { setProject(null); return; }
    const seq = ++searchSeq.current;
    // With no query it would be every line in the repo.
    if (deepQuery.length < SEARCH_MIN_QUERY) { setProject(null); return; }
    setSearching(true);
    const t = setTimeout(() => {
      // At the line that matched: the hit is a line, and the top of the file is not where it is.
      const open = (path: string, line: number) => run(async () => { await openDocumentPath(path, null, null, { line }); setPaletteOpen(false); });
      void searchProjectText(deepQuery).then((r) => r && r.hits.map((h): Entry => ({
        id: `grep:${h.path}:${h.line}`, section: "In files", deep: true,
        label: `${h.path}:${h.line}`, hint: <Snippet parts={h.segments} />,
        icon: <Icon name="code" size={16} />, run: () => open(h.path, h.line),
      }))).then((rows) => {
        if (searchSeq.current !== seq) return;
        setProject({ forQuery: deepQuery, rows: rows ?? [], cwd: rows !== null });
        setSearching(false);
      }).catch(() => { if (searchSeq.current === seq) { setProject(null); setSearching(false); } });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [paletteMode, deepQuery, searchProjectText, openDocumentPath, setPaletteOpen, run]);

  const entries = useMemo<Entry[]>(() => {
    const l = layout ?? emptyLayout();
    const openIds = openItemIds(l);
    const byId = new Map(items.map((i) => [i.id, i]));
    const spaceName = (id: string) => spaces.find((sp) => sp.id === id)?.name ?? "";
    const focusedItemId = itemIdOfLeaf(l, focusedLeafId);
    const focusedItem = focusedItemId ? byId.get(focusedItemId) ?? null : null;
    const focusedSession = focusedItem?.kind === "session" ? focusedItem.refId : null;
    const focusedRunning = !!focusedSession && (sessionStatus[focusedSession] ?? sessions[focusedSession]?.status) === "running";
    const intent = closeIntent(l, focusedLeafId, (id) => byId.get(id));
    const closeLabel = intent ? CLOSE_LABEL[intent.kind] : null;
    const byRecency = (a: Item, b: Item) => b.updatedAt - a.updatedAt;

    const itemEntry = (it: Item, section: string, hint: ReactNode): Entry => ({
      id: `item:${it.id}`, label: it.title, hint, icon: <ItemIcon item={it} size={16} />, section,
      // From any space — and another profile's switches the window to it first.
      run: () => run(() => revealItem(it.id, it.spaceId)),
    });

    // What is on screen, in layout order — the quadrant glyph tells duplicates apart (V-F4).
    const open = openIds.map((id) => byId.get(id)).filter((it): it is Item => !!it)
      .map((it) => itemEntry(it, "Open", <ItemGlyph layout={l} itemId={it.id} />));
    // The current space's remaining items, newest first. Archived ones are left out — `items` carries
    // them (the sidebar's Archived section needs them) where `allItems` already does not, so the
    // filter belongs here to keep both halves of this list answering the same question.
    const activeRest = items.filter((it) => it.spaceId === activeSpaceId && !openIds.includes(it.id) && !it.archived).sort(byRecency)
      .map((it) => itemEntry(it, spaceName(it.spaceId), <span>{relTime(it.updatedAt)}</span>));
    // Other spaces' items, grouped per space (strip order), newest first within each — minus what is
    // on screen, which the view may now hold from any of them.
    const others = spaces.filter((sp) => sp.id !== activeSpaceId).flatMap((sp) =>
      allItems.filter((it) => it.spaceId === sp.id && !openIds.includes(it.id)).sort(byRecency)
        .map((it) => itemEntry(it, sp.name, <span>{sp.name} · {relTime(it.updatedAt)}</span>)));

    const anyWaiting = Object.values(sessionStatus).includes("waiting_permission");
    const act = (id: string, label: string, icon: string, run_: () => void, hint?: ReactNode): Entry =>
      ({ id: `act:${id}`, label, icon: <Icon name={icon} size={16} />, run: run_, section: "Actions", hint });
    const actions: Entry[] = [
      // A pending permission anywhere leads the actions — it is the hottest thing in the app (U-H4).
      ...(anyWaiting ? [act("respond-permission", "Respond to pending permission", "alert", () => run(() => jumpToPermission()))] : []),
      // The overview (⌘⇧Space). Ahead of the per-space switches below because it is the one entry that
      // stays useful at any number of spaces — the switches are a list that grows with the home.
      act("all-spaces", "All spaces", "layout", () => setSpacesOpen(true), kbd("spaces.toggle")),
      // Built directly rather than via `act()`: a space's icon can be an emoji or a saved asset
      // (`parseSpaceIcon`), not just a Hugeicons name, so it needs `SpaceIcon`'s resolver — the same
      // reason the `item:` entries above bypass `act()` for `ItemGlyph`.
      ...spaces.map((sp): Entry => ({
        id: `act:space-${sp.id}`, label: `Switch to ${sp.name}`, icon: <SpaceIcon icon={sp.icon} size={16} />,
        run: () => run(() => selectSpace(sp.id)), section: "Actions", hint: sp.id === activeSpaceId ? "current" : undefined,
      })),
      act("new-terminal", "New terminal", "terminal", () => run(() => newTerminal()), kbd("terminal.new")),
      act("new-browser", "New browser", "browser", () => run(() => newBrowser())),
      /* "Connect", not "New machine": what this makes is a pane with a connect flow in it, and a
         machine only exists once there is somewhere to reach. It lands where you are looking, like
         the browser above it — the session pane's own button is the one that opens beside. */
      act("new-machine", "Connect a machine", "machine", () => run(() => newMachine())),
      // "Documents", not "New documents": one workspace per environment (the server dedupes), so this
      // is an open-or-focus, and calling it "New" would promise a second pane it will never create.
      act("open-documents", "Documents", "documents", () => run(() => openDocuments())),
      /* The side pane's own: a new tab there, and the session's tools that have no other entry here —
         each the row the side pane's "+" carries, so nothing that left the session's bar is only in a
         menu. */
      act("new-tab", "New tab", "add", () => run(() => newTab()), kbd("pane.newTab")),
      act("new-simulator", "Open a simulator", "simulator", () => run(() => newSimulator(null, besideSession ? { sessionId: besideSession } : false))),
      ...(besideSession ? [
        act("show-terminal", "Show terminal", "terminal", () => run(() => showSessionTerminal(besideSession)), kbdIn("terminal.toggle", { sessionFocus: true })),
        act("sub-agents", "Sub-agents", "agents", () => run(() => openAgentsTab(besideSession))),
      ] : []),
      // Plan 22 — the lecture loop. Sheets, not one-shots: each needs one input (a topic, a pick, a
      // selection) the palette cannot take inline.
      ...(activeSpaceId ? [
        act("new-lecture", "New lecture…", "documents", () => openSheet({ kind: "new-lecture" })),
        act("wrap-up-lecture", "Wrap up a lecture…", "mic", () => openSheet({ kind: "wrap-up-lecture" })),
        act("plynn-import", "Import recording from Plynn…", "mic", () => openSheet({ kind: "plynn-import" })),
      ] : []),
      // No ellipsis and no sheet (W3): both this and the per-agent one-shots below go straight through
      // newSession — the only difference is whether the agent is named or inherited from last use.
      act("new-session", "New session", "session", () => run(() => newSessionInstant()), kbd("session.new")),
      ...(plainFolder ? [] : [act("new-session-worktree", "New session in a worktree", "branch", () => run(() => newSessionInWorktree()))]),
      // Dispatch (Plan 13 W2): the honest simple palette shape — it dispatches the FOCUSED session's
      // current draft, and with no draft to dispatch it is disabled and says what would arm it,
      // rather than pretending to a "focus the composer with a hint" flow the palette cannot honor
      // (picking an entry closes the palette; a hint nobody sees is not a hint).
      ...(focusedSession ? [{
        id: "act:dispatch", section: "Actions", icon: <Icon name="send" size={16} />,
        label: "Dispatch task", hint: (drafts[focusedSession] ?? "").trim() ? kbd("session.dispatchDraft") : "type a draft first",
        disabled: !(drafts[focusedSession] ?? "").trim(),
        run: () => run(() => dispatchDraft(focusedSession)),
      } as Entry] : []),
      ...SELECTABLE_AGENT_KINDS.map((a) => act(`new-${a}`, `New ${AGENT_META[a].label} session`, AGENT_META[a].icon, () => run(() => newSession({ agentKind: a })))),
      act("new-space", "New space…", "add", () => openSheet({ kind: "new-space" })),
      // A space is a PAGE (Plan 12 W3): this shows the space's Overview over the workspace.
      ...(activeSpaceId ? [act("open-space", "Open space", "settings", () => openSpacePage(activeSpaceId))] : []),
      // The active space's PROFILE page (Plan 14 W2) — same gate: the page reads from a space.
      ...(activeSpaceId ? [act("open-profile", "Open profile", "profile-page", () => openProfilePage())] : []),
      // Plan 27 Phase 2: a profile is an identity with its own window. Every OTHER profile can open
      // beside this one — the window's own profile is already on screen, here.
      act("new-profile", "New profile…", "user", () => openNewProfileSheet()),
      ...profiles.filter((p) => p.id !== activeProfileId).map((p) =>
        act(`open-profile-window-${p.id}`, `Open ${p.name} in a new window`, "user", () => run(() => openProfileWindow(p.id)))),
      /* The sidebar destinations (W4), one entry each. They used to carry a second — "in this pane" —
         because a page was a layout item and where it landed was a real choice. A page is an overlay
         now: there is one, it is over everything, and a placement to choose would be a choice with
         no outcome. */
      ...(activeSpaceId ? DESTINATIONS.map(([kind, noun]) =>
        act(`open-${noun}`, `Open ${noun}`, kind, () => openDestinationPage(kind))) : []),
      // Global (every space's calls, W7) — unlike the space page above, it never needs an activeSpaceId.
      act("mcp-activity", "MCP Activity", "tool", () => run(() => openActivity())),
      // Unavailable while there is no room for another pane at its floor, and saying what would make
      // room — the same sentence the pane's menu row wears and the key's toast says.
      { ...act("split-right", "Split right", "layout", () => run(() => splitFocused("row")), splitWhyRow ?? kbd("pane.splitRight")), disabled: !!splitWhyRow },
      { ...act("split-down", "Split down", "layout", () => run(() => splitFocused("col")), splitWhyCol ?? kbd("pane.splitDown")), disabled: !!splitWhyCol },
      ...(closeLabel ? [act("close-pane", closeLabel, "close", () => run(() => closeInPane()), kbd("pane.close"))] : []),
      ...(focusedItem ? [
        // The pane keeps its place in the view either way — this only changes how much room it gets.
        zoomedLeaf
          ? act("unfocus-pane", "Unfocus pane", "unfocusPane", () => run(() => toggleFocusPane()), kbd("pane.toggleFocus"))
          : act("focus-pane", `Focus “${focusedItem.title}”`, "focusPane", () => run(() => toggleFocusPane()), kbd("pane.toggleFocus")),
        act("rename", `Rename “${focusedItem.title}”`, "edit", () => requestRename(focusedItem.id)),
      ] : []),
      ...(focusedRunning ? [act("interrupt", "Interrupt running session", "stop", () => run(() => interruptSession(focusedSession!)), kbd("session.interrupt"))] : []),
    ];

    const themes = MODES.map<Entry>((t) => ({
      id: `theme:${t}`, label: `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`, hint: themePref === t ? "current" : undefined,
      icon: <Icon name={t === "dark" ? "moon" : "sun"} size={16} />, section: "Theme", run: () => run(() => setThemePref(t)),
    }));

    // The palette axis, in the same section: light/dark and which colours are the same question to
    // anyone reaching for ⌘K. It sets the palette for the face ON SCREEN and offers only palettes
    // that have that face — reaching for ⌘K is reaching for what you are looking at, and a picker
    // here for the face you cannot see would change the window at some unrelated later moment.
    const palettes = THEMES.filter((t) => themeModes(t.name).includes(mode)).map<Entry>((t) => ({
      id: `palette:${t.name}`, label: `Palette: ${t.label}`, section: "Theme",
      hint: themeNames[mode] === t.name ? `current · ${mode}` : mode,
      icon: <Icon name="paintBucket" size={16} />, run: () => run(() => setThemeName(mode, t.name)),
    }));

    return [...open, ...activeRest, ...others, ...actions, ...themes, ...palettes];
  }, [kbd, kbdIn, spaces, activeSpaceId, plainFolder, items, allItems, layout, focusedLeafId, sessions, sessionStatus, themePref, themeNames, mode, drafts, dispatchDraft,
      selectSpace, revealItem, newTerminal, newBrowser, newMachine, newSimulator, newTab, showSessionTerminal, openAgentsTab, besideSession, openDocuments, newSession, newSessionInstant, newSessionInWorktree, splitFocused, splitWhyRow, splitWhyCol, closeInPane, requestRename,
      interruptSession, jumpToPermission, setThemePref, setThemeName, openSheet, openSpacePage, openDestinationPage, openProfilePage, openActivity, setSpacesOpen, run,
      profiles, activeProfileId, openProfileWindow, openNewProfileSheet,
      zoomedLeaf, toggleFocusPane]);

  // Empty query: everything, grouped under faint section headers. With a query: a flat list ranked
  // by match score (ties keep the sectioned order, so recency still breaks ties).
  const q = query.trim();
  const filtered = useMemo(() => {
    if (!q) return entries;
    return entries
      .map((e, i) => ({ e, i, score: matchScore(q, e.label) }))
      .filter((x): x is { e: Entry; i: number; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.e);
  }, [entries, q]);

  // Deep rows (Plan 16 W2), grouped Sessions / Skills / Memory / Items and appended after the
  // instant rows. Item hits already matched instantly (subsequence matching subsumes word matching)
  // are dropped rather than shown twice.
  const deepEntries = useMemo<Entry[]>(() => {
    if (!q || !deep || deep.forQuery !== q) return [];
    const shown = new Set(filtered.map((e) => e.id));
    const r = deep.results;
    const out: Entry[] = [];
    for (const h of r.sessions) {
      out.push({
        id: `deep-session:${h.sessionId}:${h.seq}`, deep: true, section: "Sessions",
        label: h.title, icon: <Icon name="session" size={16} />, hint: <Snippet parts={h.snippet} />,
        // Jump = open the session (scroll-to-event is not cheap today: transcript block keys are
        // index-based, not seq-based — the hit's `seq` is on the wire for the day it becomes so).
        run: () => run(async () => {
          const it = items.find((x) => x.kind === "session" && x.refId === h.sessionId)
            ?? allItems.find((x) => x.kind === "session" && x.refId === h.sessionId);
          if (it) await revealItem(it.id, h.spaceId);
        }),
      });
    }
    for (const h of r.skills) {
      out.push({
        id: `deep-skill:${h.id}`, deep: true, section: "Skills", label: h.name,
        icon: <Icon name="library-page" size={16} />, hint: <Snippet parts={h.snippet} />,
        run: () => openDestinationPage("library-page"),
      });
    }
    for (const h of r.memory) {
      out.push({
        id: `deep-memory:${h.scope}:${h.spaceId ?? h.profileId}`, deep: true, section: "Memory", label: h.title,
        icon: <Icon name="context" size={16} />, hint: <Snippet parts={h.snippet} />,
        run: () => run(async () => {
          if (h.scope === "profile") { openProfilePage("memory"); return; }
          if (!h.spaceId) return;
          openSpacePage(h.spaceId, "memory");
        }),
      });
    }
    for (const h of r.items) {
      if (shown.has(`item:${h.itemId}`)) continue; // already an instant row above
      out.push({
        id: `deep-item:${h.itemId}`, deep: true, section: "Items", label: h.title,
        icon: <Icon name={h.itemKind} size={16} />, hint: <Snippet parts={h.snippet} />,
        run: () => run(() => revealItem(h.itemId, h.spaceId)),
      });
    }
    return out;
  }, [q, deep, filtered, allItems, items, revealItem, openDestinationPage, openProfilePage, openSpacePage, run]);

  /* A narrowed palette shows ONLY the checkout's answer: the instant rows are Realm's own objects and
     mixing them into "open a file" would make the top of the list mean something different from the
     rest of it. Stale answers are dropped by query rather than rendered against the wrong text. */
  const combined = paletteMode !== "all"
    ? (project?.forQuery === deepQuery ? project.rows : [])
    : q ? [...filtered, ...deepEntries] : filtered;
  const sel = Math.min(index, Math.max(0, combined.length - 1));

  useEffect(() => { listRef.current?.querySelector<HTMLElement>(`[data-index="${sel}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [sel]);

  const pick = (e: Entry | undefined) => { if (!e || e.disabled) return; e.run(); close(); };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex(Math.min(combined.length - 1, sel + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIndex(Math.max(0, sel - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(combined[sel]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };

  return (
    <div className="palette-backdrop" data-closing={closing || undefined}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" role="dialog" aria-label="Command palette" style={paletteStyle}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input autoFocus role="combobox" aria-label="Command palette" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
            aria-activedescendant={combined[sel] ? `palette-opt-${sel}` : undefined}
            placeholder={PALETTE_PLACEHOLDER[paletteMode]} value={query} onChange={(e) => { setQuery(e.target.value); setIndex(0); }} onKeyDown={onKeyDown} />
          <kbd>esc</kbd>
        </div>
        <div id="palette-list" ref={listRef} role="listbox" className="palette-list">
          {/* Honest quiet states: while a deep query is in flight an empty list says so; only a
              settled empty answer says "No matches". Instant rows render regardless, immediately. */}
          {combined.length === 0 && (searching
            ? <div className="palette-empty muted">Searching…</div>
            /* A narrowed palette with no checkout is not "no matches" — there is nothing to match
               against, and saying the former sends someone looking for a typo in their query. */
            : paletteMode !== "all" && project?.cwd === false
              ? <div className="palette-empty muted">This space has no checkout yet — link a project to search its files.</div>
            : paletteMode === "grep" && deepQuery.length < SEARCH_MIN_QUERY
              ? <div className="palette-empty muted">Type at least {SEARCH_MIN_QUERY} characters to search file contents.</div>
            : <div className="palette-empty muted">No matches</div>)}
          {combined.map((e, i) => (
            <Fragment key={e.id}>
              {(!q || e.deep) && (i === 0 || combined[i - 1]!.section !== e.section) && (
                <div className="palette-sec" role="presentation">{e.section}</div>
              )}
              <div id={`palette-opt-${i}`} role="option" aria-selected={i === sel} aria-disabled={e.disabled || undefined} data-index={i}
                className={"palette-opt" + (i === sel ? " selected" : "") + (e.disabled ? " disabled" : "")}
                onMouseEnter={() => setIndex(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(e)}>
                <span className="palette-icon">{e.icon}</span><span className="palette-label">{e.display ?? e.label}</span>
                {e.hint && <span className="palette-hint">{e.hint}</span>}
              </div>
            </Fragment>
          ))}
          {searching && combined.length > 0 && <div className="palette-empty muted">Searching…</div>}
        </div>
      </div>
    </div>
  );
}
