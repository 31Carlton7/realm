import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** design.md: quiet text is text. What a person must read sits on an ink that clears 4.5:1 on every
 *  ground it appears on, in both faces. On the phone that ink is `Palette.ink2`, and the system's own
 *  grey — a list's heads and footers, a value beside its label, a bar's subtitle,
 *  `ContentUnavailableView`'s line, all 3.3:1 on the light ground — is drawn in it instead. `Palette.ink3`
 *  is left to what a reader may skip: an age, a count, a placeholder, as on the Mac. */
const app = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, app), "utf8");
const sources = ["Realm/", "RealmActivity/", "RealmShare/", "RealmNotificationService/"].flatMap((dir) =>
  readdirSync(new URL(dir, app), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".swift"))
    .map((path) => ({ path: dir + path, text: read(dir + path) })),
);

type Face = "light" | "dark";
const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** A colour set's relative luminance in each face, from the Display P3 components the phone draws. */
function luminance(name: string): Record<Face, number> {
  const set = JSON.parse(read(`Realm/Assets.xcassets/Palette/${name}.colorset/Contents.json`));
  const out = {} as Record<Face, number>;
  for (const entry of set.colors) {
    const { red, green, blue } = entry.color.components;
    const [r, g, b] = [red, green, blue].map((v: string) => linear(Number(v)));
    out[entry.appearances ? "dark" : "light"] = 0.2289746 * r + 0.6917385 * g + 0.0792869 * b;
  }
  return out;
}

const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Every ground text is drawn on: the page and canvas, a card, a well, a pressed row, a field. */
const grounds = ["Page", "Canvas", "Surface", "Inset", "Hover", "Hover2", "Field"];
const colourSet: Record<string, string> = { ink: "Ink", ink2: "Ink2", ink3: "Ink3" };

/** Each face and ground where an ink falls under 4.5:1, as "dark Surface 3.08". */
function below(ink: string): string[] {
  const text = luminance(colourSet[ink] ?? ink);
  return grounds.flatMap((ground) =>
    (["light", "dark"] as const).flatMap((face) => {
      const measured = ratio(text[face], luminance(ground)[face]);
      return measured < 4.5 ? [`${face} ${ground} ${measured.toFixed(2)}`] : [];
    }),
  );
}

/** The `Palette` ink the first `foregroundStyle` after `anchor` sets. */
function inkAfter(path: string, anchor: string): string {
  const text = read(path);
  const at = text.indexOf(anchor);
  expect(at, `${path} no longer has ${anchor}`).toBeGreaterThanOrEqual(0);
  return text.slice(at).match(/\.foregroundStyle\(Palette\.(\w+)\)/)![1];
}

describe("quiet text on the phone", () => {
  it("reads at 4.5:1 or better in Ink and Ink2, on every ground, in both faces", () => {
    expect(below("Ink")).toEqual([]);
    expect(below("Ink2")).toEqual([]);
  });

  it("takes the secondary ink where iOS draws its own grey: list heads and footers, values, bar subtitles", () => {
    const stringHeads = sources.flatMap(({ path, text }) =>
      text.split("\n").flatMap((line, i) => (/\bSection\("/.test(line) ? [`${path}:${i + 1}`] : [])));
    expect(stringHeads).toEqual([]);
    expect(below(inkAfter("Realm/Theme/Surfaces.swift", "init(head: String"))).toEqual([]);
    expect(below(inkAfter("Realm/Theme/Surfaces.swift", "struct ValueInk"))).toEqual([]);
    expect(read("Realm/Views/RootView.swift")).toMatch(/\.labeledContentStyle\(ValueInk\(\)\)/);
    const subtitle = read("Realm/RealmApp.swift").match(/subtitleTextAttributes = \[\.foregroundColor: UIColor\(Palette\.(\w+)\)\]/);
    expect(subtitle, "RealmApp sets no subtitle ink").not.toBeNull();
    expect(below(subtitle![1])).toEqual([]);
  });

  it("draws every placeholder in the desktop's placeholder ink, never the system's", () => {
    const bare = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/\bTextField\(/g)].flatMap((m) => {
        const call = text.slice(m.index, text.indexOf("\n", text.indexOf("\n", m.index) + 1));
        return /prompt: Text\([^\n]*\)\.foregroundStyle\(Palette\.ink3\)/.test(call) ? [] : [`${path}: ${call.split("\n")[0].trim()}`];
      }));
    expect(bare).toEqual([]);
  });

  it("draws every empty view through EmptyState, its line in a reading ink", () => {
    const system = sources.flatMap(({ path, text }) =>
      text.split("\n").flatMap((line, i) => (/ContentUnavailableView[({]/.test(line) ? [`${path}:${i + 1}`] : [])));
    expect(system).toEqual([]);
    expect(below(inkAfter("Realm/Theme/EmptyState.swift", "Text(description)"))).toEqual([]);
  });

  it("reads the lines the audit measured under 4.5:1", () => {
    const sites = [
      ["Realm/Views/SuggestionPanel.swift", "Text(head)"], // a mention list's section head, 3.08:1 in dark
      ["Realm/Views/SuggestionPanel.swift", "Text(detail)"], // a command's or a mention's hint, 3.08:1 in dark
      ["Realm/Views/SearchViews.swift", "Text(place.words)"], // find in session's "2 of 5", 3.08:1 in dark
    ];
    for (const [path, anchor] of sites) expect(below(inkAfter(path, anchor)), `${path} ${anchor}`).toEqual([]);
  });
});
