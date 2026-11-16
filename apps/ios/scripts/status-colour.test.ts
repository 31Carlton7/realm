import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** design.md: on the phone amber is the only colour a state wears, and it comes through
 *  `Tone.agentColor`. A diff's green and red are the diff's (`DiffInk`), a destructive action's red is
 *  the action's (`DestructiveInk`), and a teammate's or a profile's colour is who it is, never a state. */
const app = new URL("../", import.meta.url);
const sources = ["Realm/", "RealmActivity/", "RealmShare/", "RealmNotificationService/"].flatMap((dir) =>
  readdirSync(new URL(dir, app), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".swift"))
    .map((path) => ({ path: dir + path, text: readFileSync(new URL(dir + path, app), "utf8") })),
);
const surfaces = sources.find(({ path }) => path === "Realm/Theme/Surfaces.swift")!.text;
const outsideTheme = sources.filter(({ path }) => path !== "Realm/Theme/Surfaces.swift" && path !== "Realm/Theme/Palette.swift");
const lines = (pattern: RegExp, files = outsideTheme) =>
  files.flatMap(({ path, text }) => text.split("\n").flatMap((line, i) => (pattern.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])));

describe("a state's colour on the phone", () => {
  it("is amber or the quiet ink, and Tone has no other colour to give", () => {
    const tone = surfaces.match(/\nenum Tone \{[\s\S]*?\n}\n/)![0];
    expect([...tone.matchAll(/var (\w+): Color/g)].map((m) => m[1])).toEqual(["agentColor"]);
    expect([...new Set(tone.match(/Palette\.\w+/g))].sort()).toEqual(["Palette.ink2", "Palette.orange"]);
  });

  it("comes only through Tone.agentColor: no view names a state hue of its own", () => {
    expect(lines(/Palette\.(orange|orangeTint|green|greenTint|red|redTint)\b/)).toEqual([]);
    expect(lines(/\b(Color|UIColor)\.(red|green|orange|yellow|blue|mint|teal|cyan|purple|pink|indigo|system\w+)\b/)).toEqual([]);
    expect(lines(/(foregroundStyle|foregroundColor|fill|stroke|strokeBorder|background)\(\s*\.(red|green|orange|yellow|blue|mint|teal|cyan|purple|pink|indigo)\b/)).toEqual([]);
  });

  it("leaves green and red to the diffs", () => {
    const diffs = ["Realm/Views/ChangesViews.swift", "Realm/Views/TranscriptRows.swift"];
    expect(lines(/\bDiffInk\./).filter((line) => !diffs.some((path) => line.startsWith(`${path}:`)))).toEqual([]);
  });
});
