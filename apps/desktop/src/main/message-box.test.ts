import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shown: unknown[][] = [];
vi.mock("electron", () => ({
  dialog: { showMessageBox: async (...args: unknown[]) => { shown.push(args); return { response: 0, checkboxChecked: false }; } },
}));
const { askAppModal, askInSheet, sheetWindow } = await import("./message-box");

/* Vite rewrites `import.meta.url` to a non-file scheme under jsdom, so walk up from the cwd — the
   same trick `agent-cursor.test.ts` uses. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const MAIN = repoFile("apps/desktop/src/main");

function sources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sources(path));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function fakeWindow(d: { visible?: boolean; minimized?: boolean; destroyed?: boolean } = {}) {
  return {
    isVisible: () => d.visible ?? true,
    isMinimized: () => d.minimized ?? false,
    isDestroyed: () => d.destroyed ?? false,
  } as never;
}

beforeEach(() => { shown.length = 0; });

describe("askInSheet", () => {
  // Mutant: drop the window and call `dialog.showMessageBox(options)` — the app-modal alert of #562.
  it("always passes the window, so macOS shows a sheet and not an app-modal alert", async () => {
    const win = fakeWindow();
    expect(await askInSheet(win, { message: "Realm v9.9.9 is ready to install.", buttons: ["Restart and update", "Later"] })).toBe(0);
    expect(shown).toHaveLength(1);
    expect(shown[0]![0]).toBe(win);
  });

  // Mutant: return `win` from `sheetWindow` whatever its state. A sheet on a window nobody can see
  // waits for an answer that never comes.
  it.each([
    ["no window", null],
    ["a hidden window", fakeWindow({ visible: false })],
    ["a minimised window", fakeWindow({ minimized: true })],
    ["a closed window", fakeWindow({ destroyed: true })],
  ])("shows nothing and answers null with %s", async (_what, win) => {
    expect(sheetWindow(win)).toBeNull();
    expect(await askInSheet(win, { message: "Realm couldn't install the update" })).toBeNull();
    expect(shown).toEqual([]);
  });
});

describe("message boxes in main", () => {
  // Mutant: put `void dialog.showMessageBox({...})` back in `onDownloaded` (index.ts).
  it("are shown only by message-box.ts", () => {
    const callers = sources(MAIN)
      .filter((path) => !path.endsWith("message-box.ts"))
      .filter((path) => /\bshowMessageBox(Sync)?\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(MAIN, path));
    expect(callers).toEqual([]);
  });

  // `showErrorBox` is app-modal too, with no window to put a sheet on. "Realm failed to start" is
  // its one use, because nothing else is running yet; anything later belongs in a log (#567).
  // Mutant: show an uncaught exception with `dialog.showErrorBox` in `uncaught.ts`.
  it("show an error box only when Realm failed to start", () => {
    const calls: string[] = [];
    for (const path of sources(MAIN)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (/\bshowErrorBox\s*\(/.test(line)) calls.push(`${relative(MAIN, path)} ${line.match(/showErrorBox\(\s*("[^"]*")?/)?.[1]}`);
      }
    }
    expect(calls).toEqual(['index.ts "Realm failed to start"']);
  });

  // Mutant: show the update-ready prompt with `askAppModal`. Each caller here is a click the person
  // has just made; anything that fires on its own must use a sheet.
  it("are app-modal only for the tray's quit and a launch's hand-off", () => {
    const callers: string[] = [];
    for (const path of sources(MAIN)) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\baskAppModal\(/.test(line) || line.includes("export async function askAppModal")) return;
        const enclosing = lines.slice(0, i).reverse().find((l) => /^(export )?(async )?function \w+/.test(l));
        callers.push(`${relative(MAIN, path)} ${enclosing?.match(/function (\w+)/)?.[1]}`);
      });
    }
    expect(callers.sort()).toEqual(["index.ts handOff", "index.ts quitAndStopAll"]);
  });

  it("include the module's own app-modal alert, which passes no window", async () => {
    expect(await askAppModal({ message: "Quit Realm and stop agents?" })).toBe(0);
    expect(shown).toEqual([[{ message: "Quit Realm and stop agents?" }]]);
  });
});
