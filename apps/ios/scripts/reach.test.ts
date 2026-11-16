import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The Nov 12 audit timed the phone's tasks on a Pro Max held in one hand, where only the lower part of
 *  the screen is in easy reach of the thumb. These are the screens it found working across the top:
 *  New session (COMP-09), a question's answer (APPR-02), search results (SRCH-03) and the Move sheet
 *  (INFO-01). Each one now keeps what is pressed every time at its foot, and each target on them is at
 *  least 44 pt, design.md's floor for touch. */
const views = new URL("../Realm/Views/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, views), "utf8");
const body = (text: string, head: string) => {
  const start = text.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end);
};

describe("thumb reach on a tall phone", () => {
  it("puts New session's chips, field and Start at the sheet's foot", () => {
    const sheet = body(read("NewSessionSheet.swift"), "struct NewSessionSheet: View");
    expect(sheet).toContain(".defaultScrollAnchor(.bottom, for: .alignment)");
    expect(sheet).toContain(".defaultScrollAnchor(.bottom, for: .initialOffset)");
  });

  it("answers one question's few options on the dock, with one tap", () => {
    const requests = read("RequestViews.swift");
    const dock = body(requests, "struct WaitingDock: View");
    expect(dock).toMatch(/case \.questions:\s*if let question = OneTapQuestion\.of\(request\) \{\s*oneTap\(question/);
    expect(dock).toMatch(/Button \{\s*model\.submit\(OneTapQuestion\.answer\(option/);
  });

  it("lets only the dock's card cast its shadow, not each option on it", () => {
    const dock = body(read("RequestViews.swift"), "struct WaitingDock: View");
    expect(dock).toMatch(/\.compositingGroup\(\)\s*\.shadow\(/);
  });

  it("keeps the question sheet's Send at its foot", () => {
    const sheet = body(read("RequestViews.swift"), "struct QuestionSheet: View");
    expect(sheet).not.toContain(".confirmationAction");
    expect(sheet).toMatch(/\.safeAreaBar\(edge: \.bottom\) \{\s*Button \{\s*model\.submit\(draft\)/);
    // Faint while not ready, so it stands on the sheet's ground rather than over the list.
    expect(sheet).toMatch(/\.buttonStyle\(InkButtonStyle\(\)\)\s*(\/\/[^\n]*\s*)?\.background\(Ground\.grouped, in: Capsule\(\)\)\s*\.disabled\(!draft\.isComplete\)/);
  });

  it("grows search results up from the field, the best nearest it", () => {
    const home = body(read("HomeView.swift"), "struct HomeView: View");
    // A List ignores the alignment anchor, so a short page of results is pushed down by the room over it.
    expect(home).toContain(".contentMargins(.top, matches == nil ? 0 : resultsLift, for: .scrollContent)");
    expect(home).toMatch(/\.onScrollGeometryChange\(for: CGFloat\.self\) \{ geometry in\s*geometry\.containerSize\.height - geometry\.contentInsets\.top - geometry\.contentInsets\.bottom - geometry\.contentSize\.height/);
    expect(home).toContain("resultsLift = matches == nil ? 0 : max(0, resultsLift + room)");
    expect(home).toContain(".contentMargins(.bottom, searching ? 0 : 72, for: .scrollContent)");
    // More than fit open at the best, scrolled to the foot whenever new results come.
    expect(home).toContain(".modifier(BestResultInView(best: matches?.hits.first?.id))");
    expect(body(read("HomeView.swift"), "private struct BestResultInView: ViewModifier")).toMatch(
      /content\.onChange\(of: best, initial: true\) \{\s*if let best \{ proxy\.scrollTo\(best, anchor: \.bottom\) \}/,
    );
    expect(body(read("SearchViews.swift"), "struct SearchHitsSection: View")).toContain("ForEach(found.hits.reversed())");
  });

  it("opens the Move sheet whole, so its list ends above Move", () => {
    const move = body(read("MoveSheet.swift"), "struct MoveSheet: View");
    expect(move).toContain(".presentationDetents([.large])");
    expect(move).not.toContain(".medium");
  });

  it("sizes every target on these screens at 44 pt or more", () => {
    const short = ["NewSessionSheet.swift", "RequestViews.swift", "SearchViews.swift", "MoveSheet.swift"].flatMap((name) =>
      [...read(name).matchAll(/\.frame\(([^)\n]*)\)/g)].flatMap(([frame, args]) =>
        [...args!.matchAll(/\b(width|height|minHeight|minWidth): (\d+)/g)]
          // A width alone is a glyph's column; a size with a height is something to press.
          .filter(([, , n]) => /height|minHeight/i.test(args!) && Number(n) < 44)
          .map(() => `${name}: ${frame}`),
      ),
    );
    expect(short).toEqual([]);
  });
});
