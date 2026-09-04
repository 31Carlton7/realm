import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SpacePage } from "../panes/space/SpacePage";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item } from "../state/store.test-fakes";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/* Vite rewrites `import.meta.url` to a non-file scheme under jsdom, so walk up from the cwd instead
   (vitest may be invoked from the repo root or from apps/desktop) — same helper styles.test.ts uses. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const SRC = "apps/desktop/src/renderer/src/components";
/** Budget for the lazy chunk to arrive (see the note at its first use). Generous because the import is
 *  real: under a loaded machine Vite's transform of the 387KB dataset takes seconds, and vitest's own
 *  5s per-test default fires first — so the two tests that load it carry an explicit budget too. */
const CHUNK_MS = 20_000;

const pageItem = (spaceId: string) => item(`pg-${spaceId}`, spaceId, { kind: "space-page", title: "Overview", refId: spaceId });

async function mount() {
  const store = createAppStore(fakeApi()); await store.getState().boot();
  render(<StoreContext.Provider value={store}><SpacePage item={pageItem("s1")} visible /></StoreContext.Provider>);
  return store;
}

/* The emoji tab owns a 387KB dataset it walks at module scope, so it is loaded on demand rather than
   during startup. Splitting it out is only worth anything if the tab still works, and only SAFE if
   nothing else pulls the chunk in behind its back. */
describe("the icon picker's emoji tab is loaded on demand", () => {
  /* The split is a BUNDLING fact, so it is asserted against the source rather than the DOM: rendering
     cannot tell a lazy chunk from an eager one once both have loaded, but a static
     `import ... from "unicode-emoji-json"` anywhere on IconPicker's own module graph puts 387KB back
     into the startup chunk. This is the assertion that dies if someone inlines the tab again. */
  it("IconPicker itself never imports the emoji dataset — only the lazy chunk does", () => {
    const picker = readFileSync(repoFile(`${SRC}/IconPicker.tsx`), "utf8");
    expect(picker).not.toContain("unicode-emoji-json");
    expect(picker).toContain('lazy(() => import("./IconPickerEmoji"))');
    const tab = readFileSync(repoFile(`${SRC}/IconPickerEmoji.tsx`), "utf8");
    expect(tab).toContain("unicode-emoji-json");
  });

  it("opening the picker does not mount the emoji grid; choosing the tab does", async () => {
    const store = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Change icon…" }));
    // The Default tab is what opens; the emoji grid is not built until asked for.
    expect(screen.getByRole("radiogroup", { name: "Default icons" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Emoji" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Emoji" }));
    // Suspense resolves a REAL dynamic import here, and the module it pulls is a 387KB JSON file that
    // Vite must transform — a second or more on a loaded machine, well past findBy's 1s default.
    // Waiting properly is the point: a shorter wait would just be flaky about the thing under test.
    const grid = await screen.findByRole("radiogroup", { name: "Emoji" }, { timeout: CHUNK_MS });
    expect(grid).toBeTruthy();

    const grinning = await screen.findByRole("radio", { name: "grinning face" }, { timeout: CHUNK_MS });
    fireEvent.click(grinning);
    await waitFor(() => expect(store.getState().activeSpace()?.icon).toBe("emoji:😀"), { timeout: CHUNK_MS });
  }, CHUNK_MS + 10_000);

  it("the search box filters the loaded grid, and says so when nothing matches", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Change icon…" }));
    fireEvent.click(screen.getByRole("tab", { name: "Emoji" }));
    await screen.findByRole("radiogroup", { name: "Emoji" }, { timeout: CHUNK_MS });

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "rocket" } });
    await waitFor(() => expect(screen.getByRole("radio", { name: "rocket" })).toBeTruthy(), { timeout: CHUNK_MS });
    expect(screen.queryByRole("radio", { name: "grinning face" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "zzzznotanemoji" } });
    await waitFor(() => expect(screen.getByText(/No emoji match/)).toBeTruthy(), { timeout: CHUNK_MS });
  }, CHUNK_MS + 10_000);
});
