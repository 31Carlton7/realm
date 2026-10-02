import type { BrowserMenuState } from "@realm/contracts";

/**
 * The browser pane's ⋯ menu (Plan 26 W7b), as rows for the OS to draw.
 *
 * Built here and drawn by main (`menu:popup`), because a native view composites over every piece of DOM
 * in its rectangle and an OS menu is the one surface that does not lose to it. What comes back is a
 * row's id and nothing else, so every id is spelled by this file and read back by `parseBrowserMenuChoice`
 * — the two halves cannot drift apart without a test noticing.
 *
 * Left out on purpose: importing another browser's cookies or passwords (Plan 26 D3 — it would hand
 * every agent the user's real sessions, the boundary the partition exists to keep).
 */

export type BrowserMenuChoice =
  | { kind: "find" }
  | { kind: "print" }
  | { kind: "zoom"; step: "in" | "out" | "reset" }
  | { kind: "screenshot" }
  | { kind: "save-download"; id: string }
  | { kind: "show-download"; id: string }
  | { kind: "history"; index: number }
  | { kind: "clear-data" }
  | { kind: "settings" };

export type BrowserMenuInput = BrowserMenuState & {
  /** The pane has a page. With none, everything that acts on a page is drawn and disabled. */
  hasPage: boolean;
  /** The page it is on, as the History submenu names it: its title, or its address without one. */
  current: string;
};

const percent = (factor: number) => `${Math.round(factor * 100)}%`;

export function browserMenuItems(s: BrowserMenuInput): NativeMenuItem[] {
  const page = s.hasPage;
  const atActualSize = Math.abs(s.zoom - 1) < 0.001;
  return [
    // Shown with its shortcut, which the pane binds whether the keyboard is in the page or the chrome.
    { id: "find", label: "Find in page…", enabled: page, accelerator: "CmdOrCtrl+F" },
    { id: "print", label: "Print…", enabled: page },
    { type: "separator" },
    { id: "zoom:out", label: "Zoom out", enabled: page && s.canZoomOut },
    // The level rides on the row that names it: "Actual size (125%)" says where the page is and what
    // the row would undo, and at 100% there is nothing to undo.
    { id: "zoom:reset", label: `Actual size (${percent(s.zoom)})`, enabled: page && !atActualSize },
    { id: "zoom:in", label: "Zoom in", enabled: page && s.canZoomIn },
    { type: "separator" },
    { id: "screenshot", label: "Take a screenshot", enabled: page },
    { type: "separator" },
    { label: "Downloads", submenu: downloadRows(s) },
    { label: "History", enabled: page, submenu: historyRows(s) },
    { type: "separator" },
    // The confirm that follows names the consequence; the ellipsis says there is one to read.
    { id: "clear-data", label: "Clear browsing data…" },
    { id: "settings", label: "Browser settings" },
  ];
}

/**
 * What this pane blocked, then what it saved. The verbs keep the two apart: a blocked file can be
 * SAVED — the same consent the download bar's button gives, since a page cannot reach an OS menu any
 * more than it can reach the bar — and a saved one can be SHOWN in the Finder.
 */
function downloadRows(s: BrowserMenuInput): NativeMenuItem[] {
  const blocked: NativeMenuItem[] = [...s.blocked].reverse().map((b) => ({ id: `download:save:${b.id}`, label: `Save ${b.name}` }));
  const saved: NativeMenuItem[] = [...s.saved].reverse().map((d) => ({ id: `download:show:${d.id}`, label: `Show ${d.name} in Finder` }));
  if (blocked.length === 0 && saved.length === 0) return [{ label: "Nothing downloaded in this pane" }];
  return [...blocked, ...(blocked.length > 0 && saved.length > 0 ? [{ type: "separator" } as const] : []), ...saved];
}

/**
 * This pane's own trail, newest at the top: the pages ahead of it (farthest first), the page it is on
 * — ticked, and not a row to choose — then the pages behind it, nearest first. Both halves come from
 * `historyTrail`, the back/forward menu's own reading of the view.
 */
function historyRows(s: BrowserMenuInput): NativeMenuItem[] {
  return [
    ...[...s.forward].reverse().map((r) => ({ id: `history:${r.index}`, label: r.label })),
    { label: s.current || "This page", checked: true },
    ...s.back.map((r) => ({ id: `history:${r.index}`, label: r.label })),
  ];
}

export function parseBrowserMenuChoice(id: string | null): BrowserMenuChoice | null {
  if (id === null) return null;
  if (id === "find" || id === "print" || id === "screenshot" || id === "clear-data" || id === "settings") return { kind: id };
  if (id === "zoom:in" || id === "zoom:out" || id === "zoom:reset") return { kind: "zoom", step: id.slice(5) as "in" | "out" | "reset" };
  const save = /^download:save:(.+)$/.exec(id);
  if (save) return { kind: "save-download", id: save[1]! };
  const show = /^download:show:(.+)$/.exec(id);
  if (show) return { kind: "show-download", id: show[1]! };
  const history = /^history:(\d+)$/.exec(id);
  if (history) return { kind: "history", index: Number(history[1]) };
  return null;
}
