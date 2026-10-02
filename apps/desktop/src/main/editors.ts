import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EDITOR_IDS, EDITOR_NAMES, isEditorId, type EditorId, type InstalledEditor } from "@realm/contracts";

/** Each editor's app bundle, by the name it installs under. */
const BUNDLES: Record<EditorId, string> = {
  cursor: "Cursor.app", vscode: "Visual Studio Code.app", zed: "Zed.app", xcode: "Xcode.app",
};

/** Where macOS puts applications: the system folder, then the user's own. */
const appDirs = (home: string): string[] => ["/Applications", join(home, "Applications")];

/** The app bundle for an editor, or null when it is not installed in either place. */
export function editorApp(id: EditorId, exists: (p: string) => boolean = existsSync, home: string = homedir()): string | null {
  for (const dir of appDirs(home)) {
    const app = join(dir, BUNDLES[id]);
    if (exists(app)) return app;
  }
  return null;
}

/** The editors this Mac has, in the contracts' order — which is the order a default is taken in. */
export function installedEditors(exists: (p: string) => boolean = existsSync, home: string = homedir()): InstalledEditor[] {
  return EDITOR_IDS.filter((id) => editorApp(id, exists, home) !== null).map((id) => ({ id, name: EDITOR_NAMES[id] }));
}

/**
 * Open a file or folder in an editor, the way the Finder's "Open With" does — `open -a <app>`, so
 * each editor gets the path through LaunchServices and does what it does with one (a folder becomes
 * a workspace in Cursor, VS Code and Zed).
 *
 * The id must be one of the four and installed, and the path must already be absolute and real —
 * both checked here rather than trusted from the renderer — and it goes in as one argv entry, never
 * through a shell.
 */
export async function openInEditor(id: unknown, path: string | null,
  run: (cmd: string, args: string[]) => Promise<void> = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, (e) => (e ? rej(e) : res()))),
  exists: (p: string) => boolean = existsSync, home: string = homedir()): Promise<boolean> {
  if (!isEditorId(id) || !path || !path.startsWith("/")) return false;
  const app = editorApp(id, exists, home);
  if (!app) return false;
  await run("open", ["-a", app, path]);
  return true;
}
