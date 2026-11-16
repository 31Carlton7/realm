import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The Nov 12 audit found Library, Memory and Scheduled behind the bar's laptop, in a sheet called
 *  Settings, with nothing on Home saying they exist (HOME-04), Saved and Memory listed beside the Library
 *  that holds them (DOCS-02), and a scheduled run's row the twin of the session it is named like
 *  (HOME-02). Home now names the three as the desktop's rail keeps them beside Home, each page is listed
 *  once, and a run says it is one. */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const body = (text: string, head: string) => {
  const start = text.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  return text.slice(start, text.indexOf("\n}\n", start));
};

describe("Home says where the Mac's pages are", () => {
  it("names Library, Memory and Scheduled at the head of the whole list", () => {
    const home = body(read("Realm/Views/HomeView.swift"), "struct HomeView: View");
    expect(home).toMatch(/if filter == \.all \{\s*WorkHeadLines\(searching: listing\.isFiltered\)\s*if !listing\.isFiltered, !model\.work\.unsupported \{\s*HomePlaces\(\)\s*\}/);
    const menu = read("Realm/Views/HomeMenu.swift");
    expect(menu).toContain("static let onHome: [WorkPage] = [.library, .memory, .scheduled]");
    const places = body(menu, "struct HomePlaces: View");
    expect(places).toContain("ForEach(WorkPage.onHome, id: \\.self)");
    expect(places).toContain("model.path.append(page.route)");
    // At the accessibility sizes the three stand one under another rather than clip.
    expect(places).toMatch(/ViewThatFits\(in: \.horizontal\) \{\s*HStack\(spacing: 8\) \{ places \}\s*VStack\(spacing: 8\) \{ places \}/);
  });

  it("lists each page once: the Mac's sheet keeps only what Home does not show", () => {
    const menu = read("Realm/Views/HomeMenu.swift");
    expect(menu).toContain("static let inSettings: [WorkPage] = [.reviews, .usage]");
    expect(body(menu, "enum WorkPage")).toMatch(/case reviews, scheduled, usage, library, memory\n/);
    const settings = read("Realm/Views/SettingsView.swift");
    expect(settings).toContain("ForEach(WorkPage.inSettings, id: \\.self)");
    expect(settings).not.toContain("WorkPage.allCases");
  });

  it("marks a scheduled task's run on its row, drawn and spoken", () => {
    const home = read("Realm/Views/HomeView.swift");
    const row = body(home, "struct SessionRowView: View");
    expect(row).toMatch(/if row\.scheduled == true \{\s*ScheduledRunMark\(dotted: !dynamicTypeSize\.isAccessibilitySize\)/);
    expect(row).toContain('if row.scheduled == true { parts.append("Scheduled run") }');
    const mark = body(home, "private struct ScheduledRunMark: View");
    expect(mark).toContain('Text("Scheduled run")');
    expect(mark).toContain(".foregroundStyle(Palette.ink2)");
    const models = read("RealmKit/Sources/RealmKit/API/Models.swift");
    expect(models).toContain("scheduled = try? c.decodeIfPresent(Bool.self, forKey: .scheduled)");
  });
});
