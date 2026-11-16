import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** A menu on the phone is Realm's (the audit's COMP-01, @captain's call on 11-12): iOS 26 draws every
 *  system menu as glass, with the screen read through it, so a tap that opens a menu opens `RealmMenu`.
 *  What stays the system's is a long press on a row, whose lift and preview are iOS's own gesture, and
 *  the pickers in a settings form; each is named here, so a new one fails. */
const root = new URL("../Realm/", import.meta.url);
const sources = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".swift"))
  .map((path) => ({ path, text: readFileSync(new URL(path, root), "utf8") }));

/** Every line matching `pattern`, as "<file> <the type it is in>". */
function sites(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const { path, text } of sources) {
    let type = "";
    for (const line of text.split("\n")) {
      const declared = line.match(/^(?:private |fileprivate )?(?:struct|enum|extension|final class|class) (\w+)/);
      if (declared) type = declared[1]!;
      if (pattern.test(line) && !line.trim().startsWith("//")) found.push(`${path} ${type}`);
    }
  }
  return found.sort();
}

/** A long press on a row: iOS's lift and preview of the row, with its menu. */
const LONG_PRESS: Record<string, string> = {
  "Views/QueueStrip.swift QueuedRow": "a queued message",
  "Views/ScheduledView.swift TaskRow": "a scheduled task",
  "Views/SessionActions.swift SessionRowActions": "a session's row",
  "Views/TeamViews.swift ArchivedTeam": "an archived teammate's row",
  "Views/TeamViews.swift TeammateLink": "a teammate's row",
  "Views/TranscriptRows.swift UserBubble": "a sent message",
};

describe("menus on the phone", () => {
  it("open Realm's menu, never the system's", () => {
    expect(sites(/(?<![\w.])Menu\s*[({]/)).toEqual([
      // The Fork submenu of a row's long press, which is iOS's menu; in Realm's menu Fork opens in place.
      "Views/SessionActions.swift RowMenuItems",
    ]);
    expect(sites(/\.toolbarTitleMenu\b/)).toEqual([]);
    expect(sites(/\.menuStyle\(/)).toEqual([]);
  });

  it("leave only the named long presses to iOS", () => {
    expect(sites(/\.contextMenu\b/)).toEqual(Object.keys(LONG_PRESS).sort());
  });

  it("leave only the named settings pickers to iOS", () => {
    expect(sites(/\.pickerStyle\(\.menu\)/)).toEqual([
      // A session's reasoning level, in its settings sheet.
      "Views/ComposerSettings.swift SettingsForm",
      // Settings' list style and space order.
      "Views/SettingsView.swift ChoiceStyle",
    ]);
  });

  it("draw a bar's menu as a view of their own, which the bar cannot turn into its own item", () => {
    // A bar draws a button whose label is a bare Label as a native item that never reaches a window,
    // so the menu has nothing to open beside and a tap does nothing.
    const bare: string[] = [];
    for (const { path, text } of sources) {
      for (const match of text.matchAll(/RealmMenu\(/g)) {
        const label = text.slice(match.index).match(/\} label: \{\s*(\S+)/);
        if (label?.[1]?.startsWith("Label(")) bare.push(path);
      }
    }
    expect(bare).toEqual([]);
  });

  it("leave Home's subtitle to the profile switcher, which draws it under its own title", () => {
    // Set on the bar as well, the bar draws the Mac's line a second time under the switcher.
    expect(sites(/\.navigationSubtitle\(/).filter((site) => site.startsWith("Views/HomeView.swift"))).toEqual([
      "Views/HomeView.swift ProfileSwitcher",
    ]);
  });

  it("keep the large-content viewer off a button whose long press opens its menu", () => {
    // At the accessibility sizes the viewer's long press wins, and Queue and Steer never open.
    const composer = sources.find(({ path }) => path === "Views/ComposerView.swift")!.text;
    const menuPath = composer.slice(composer.indexOf("RealmMenu(kind.title"), composer.indexOf("/// Stop has to reach the Mac"));
    expect(menuPath).toContain("primaryAction");
    expect(menuPath).not.toContain("accessibilityShowsLargeContentViewer");
  });

  it("finds the menus it checks", () => {
    // The checks above pass on files they cannot read; this fails when the pattern stops matching.
    const opened = sites(/\bRealmMenu\(/);
    for (const where of [
      "Views/ComposerView.swift AddMenu",
      "Views/ComposerView.swift PrimaryButton",
      "Views/ComposerSettings.swift ModeMenu",
      "Views/SessionActions.swift SessionMenu",
      "Views/HomeView.swift ProfileSwitcher",
      "Views/HomeView.swift ViewOptionsMenu",
      "Views/NewSessionSheet.swift SpaceChip",
      "Views/NewSessionSheet.swift AgentChip",
      "Views/ScreensView.swift ScreensSheet",
      "Views/ScheduledView.swift ScheduledTaskView",
    ]) expect(opened, where).toContain(where);
  });
});

describe("Realm's menu", () => {
  const menu = readFileSync(new URL("Views/RealmMenu.swift", root), "utf8");
  const panel = menu.slice(menu.indexOf("struct RealmMenuPanel"), menu.indexOf("struct MenuColumn"));

  it("stands on the solid surface, with no glass or material behind it", () => {
    expect(panel).toContain(".background(Fill.card, in: shape)");
    expect(menu).not.toMatch(/Material|glassEffect|\.blur\(|UIVisualEffectView|UIBlurEffect/);
  });

  it("floats over what opened it, with the shared lift under its own deeper shadow", () => {
    expect(panel).toMatch(/\.shadow\(color: \.black\.opacity\(0\.1\), radius: 24, y: 10\)\s*\.floatingLift\(\)/);
  });

  it("draws the chosen row's check in the row's own ink, not the accent", () => {
    const choice = menu.slice(menu.indexOf("private struct MenuToggleRow"), menu.indexOf("private struct MenuRowLook"));
    expect(choice).toContain('Image(systemName: "checkmark")');
    expect(choice).not.toMatch(/foregroundStyle|\.tint\(|Palette\./);
  });

  it("draws each section's head in the secondary ink", () => {
    expect(panel).toMatch(/section\.header[\s\S]*?\.foregroundStyle\(Palette\.ink2\)/);
  });
});
