/**
 * The code editors a file named in a transcript can be opened in.
 *
 * Four, and only the ones installed on this Mac are ever offered: main looks for each app where macOS
 * puts applications (`main/editors.ts`), and an editor it does not find is not shown at all rather
 * than shown disabled — a menu item that cannot work is one the user has to work out how to fix.
 */
export const EDITOR_IDS = ["cursor", "vscode", "zed", "xcode"] as const;
export type EditorId = (typeof EDITOR_IDS)[number];

export const isEditorId = (x: unknown): x is EditorId =>
  typeof x === "string" && (EDITOR_IDS as readonly string[]).includes(x);

/** The names the app's own menus use for them, which is what the item says: "Open in Zed". */
export const EDITOR_NAMES: Record<EditorId, string> = { cursor: "Cursor", vscode: "VS Code", zed: "Zed", xcode: "Xcode" };

export type InstalledEditor = { id: EditorId; name: string };

/**
 * Which editor the path menu offers. An editor id; `realm` for none, so the menu offers only Realm's
 * own open; unset for the first editor this Mac has, in the order above — what someone with Cursor
 * installed most likely wants offered, chosen for them until they say otherwise.
 */
export const FILES_OPEN_IN_KEY = "files.openIn";
export type OpenFilesIn = EditorId | "realm";
export const isOpenFilesIn = (x: unknown): x is OpenFilesIn => x === "realm" || isEditorId(x);

/** The editor a preference resolves to among the installed ones, or null for none. A preference
 *  naming an editor that has since been uninstalled resolves to none rather than to another one —
 *  the user chose that editor, not "any editor". */
export function resolveEditor(pref: OpenFilesIn | null, installed: readonly InstalledEditor[]): InstalledEditor | null {
  if (pref === "realm") return null;
  if (pref === null) return installed[0] ?? null;
  return installed.find((e) => e.id === pref) ?? null;
}
