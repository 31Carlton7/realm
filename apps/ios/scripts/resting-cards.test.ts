import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** design.md: a card is its fill and nothing else, and what floats over content keeps its shadow. On
 *  the phone that is the composer and what rides on it, the request dock, the floating New session
 *  button, the search and find bars at the foot, the toast, and the mention list over the composer
 *  (the owner, 11-15: "I dislike cards with shadows here"). Every shadow the app draws is listed
 *  here by the type that casts it, so a resting card that gains one fails. */
const FLOATING: Record<string, string> = {
  "Theme/Surfaces.swift ChipButtonStyle": "a chip over the composer",
  "Views/ComposerView.swift ComposerView": "the composer",
  "Views/CurrentStep.swift WorkDock": "the work dock over the composer",
  "Views/HomeChips.swift NewSessionButton": "the floating New session button",
  "Views/HomeView.swift SearchBar": "the search field at Home's foot",
  "Views/PairView.swift ScannerScreen": "the note over the camera",
  "Views/RequestViews.swift WaitingDock": "the request dock",
  "Views/ReviewView.swift DecisionDock": "a review's decision, docked",
  "Views/RootView.swift ToastView": "the toast",
  "Views/SearchViews.swift FindBar": "find in session, at the foot",
  "Views/SessionView.swift SessionPill": "the link's pill and the way to the newest row",
  "Views/SuggestionPanel.swift SuggestionPanel": "the mention list over the composer",
  "Views/WorkingChangesViews.swift WorkingChangesView": "the commit bar over the list",
  // Not a card: the play mark's shadow keeps it legible on any picture.
  "Views/Gallery.swift GalleryTile": "the play mark over a video's picture",
};

/** Resting controls that still cast a shadow, on screens no fix has reached yet. */
const STILL_SHADOWED = ["Views/ScreensView.swift ScreensSheet"];

const root = new URL("../Realm/", import.meta.url);

/** Each file and type that draws a shadow, from the last type declared above the line that draws it. */
function shadowed(): string[] {
  const found = new Set<string>();
  for (const dir of ["Theme", "Views"]) {
    for (const name of readdirSync(new URL(`${dir}/`, root)).filter((n) => n.endsWith(".swift"))) {
      let type = "";
      for (const line of readFileSync(new URL(`${dir}/${name}`, root), "utf8").split("\n")) {
        const declared = line.match(/^(?:private |fileprivate )?(?:struct|enum|extension) (\w+)/);
        if (declared) type = declared[1]!;
        if (/\.floatingLift\(\)|\.shadow\(/.test(line) && !line.includes("func floatingLift")) found.add(`${dir}/${name} ${type}`);
      }
    }
  }
  return [...found].sort();
}

describe("resting cards on the phone", () => {
  it("cast no shadow: only what floats over content does", () => {
    expect(shadowed()).toEqual([...Object.keys(FLOATING), ...STILL_SHADOWED].sort());
  });
});
