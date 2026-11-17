import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { ThemesService, parseJsonc, readThemeFile, themeIdFor } from "./service";
import { RpcError } from "../store/rows";

let home: string;
let src: string;
let service: ThemesService;

beforeEach(() => {
  home = tempDir("realm-themes-home-");
  src = tempDir("realm-themes-src-");
  service = new ThemesService({ home });
});
afterEach(() => { for (const d of [home, src]) rmSync(d, { recursive: true, force: true }); });

const write = (name: string, body: unknown) => {
  const p = join(src, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
};

describe("parseJsonc", () => {
  it("takes the comments and trailing commas real VS Code themes carry", () => {
    /* THE MUTANT: `JSON.parse`. A large share of published themes carry at least one of these, and
       refusing them means telling someone their theme is malformed when it is not. */
    expect(parseJsonc(`{
      // a line comment
      "a": 1, /* and a block one */
      "b": [1, 2,],
    }`)).toEqual({ a: 1, b: [1, 2] });
  });

  it("does not mistake a // inside a string for a comment", () => {
    expect(parseJsonc('{ "url": "https://example.com", "c": "#aabbcc" }'))
      .toEqual({ url: "https://example.com", c: "#aabbcc" });
    // …including one that has been escaped past.
    expect(parseJsonc('{ "s": "a\\"//b" }')).toEqual({ s: 'a"//b' });
  });
});

describe("readThemeFile", () => {
  it("resolves an `include`, with the including file winning", () => {
    /* The Dark+ family is built this way — a base plus differences — and a reader that ignored
       `include` would import the differences alone, which is a theme with no background. */
    write("base.json", { colors: { "editor.background": "#111111", "editor.foreground": "#eeeeee" },
      tokenColors: [{ scope: "comment", settings: { foreground: "#555555" } }] });
    const p = write("child.json", { include: "./base.json", colors: { "editor.foreground": "#ffffff" },
      tokenColors: [{ scope: "keyword", settings: { foreground: "#ff0000" } }] });
    const t = readThemeFile(p);
    expect(t.colors).toEqual({ "editor.background": "#111111", "editor.foreground": "#ffffff" });
    // Token rules CONCATENATE base-first, because the later rule wins in `scopeColour` — which is
    // VS Code's own precedence for an included theme.
    expect((t.tokenColors as { scope: string }[]).map((r) => r.scope)).toEqual(["comment", "keyword"]);
  });

  it("costs the base, never the import, when the include is broken", () => {
    const p = write("orphan.json", { include: "./nope.json", colors: { "editor.background": "#111111" } });
    expect(readThemeFile(p).colors).toEqual({ "editor.background": "#111111" });
  });

  it("refuses something that is not an object rather than importing nothing", () => {
    expect(() => readThemeFile(write("arr.json", [1, 2]))).toThrow(RpcError);
  });
});

describe("themeIdFor", () => {
  it("makes a file name into something addressable", () => {
    expect(themeIdFor("Atomize Atom One Dark.json")).toBe("atomize-atom-one-dark");
    expect(themeIdFor("weird__name!!.jsonc")).toBe("weird-name");
  });
});

describe("ThemesService", () => {
  it("is empty, not an error, before the folder exists", () => {
    expect(service.list()).toEqual([]);
  });

  it("translates a theme and keeps it as a file a person can read", () => {
    const p = write("Night.json", {
      name: "Night", type: "dark",
      colors: { "editor.background": "#101014", "editor.foreground": "#e6e6e6", "textLink.foreground": "#7aa2f7" },
      tokenColors: [{ scope: "keyword", settings: { foreground: "#bb9af7" } }],
    });
    const t = service.import(p);
    expect(t.id).toBe("night");
    expect(t.label).toBe("Night");
    expect(t.mode).toBe("dark");
    expect(t.seed.bg).toBe("#101014");
    expect(t.seed.accent).toBe("#7aa2f7");
    // The FILE is the translated palette, not the VS Code source — so what is on disk is what the
    // app renders, and a reader can see exactly which colours their theme is made of.
    const onDisk = JSON.parse(readFileSync(join(home, "themes", "night.json"), "utf8"));
    expect(onDisk.seed.bg).toBe("#101014");
    expect(service.list().map((x) => x.id)).toEqual(["night"]);
  });

  it("reports which roles it had to work out — an import is a translation, and says so", () => {
    const t = service.import(write("Bare.json", { colors: { "editor.background": "#101014" } }));
    expect(t.source.derived).toContain("ink");
    expect(t.source.derived).toContain("syntax.keyword");
    expect(t.source.file).toContain("Bare.json");
  });

  it("believes the ground over the label when a theme's `type` disagrees with it", () => {
    const t = service.import(write("Mislabelled.json", { type: "dark", colors: { "editor.background": "#fafafa" } }));
    expect(t.mode).toBe("light");
  });

  it("replaces on re-import, so fixing the file and importing again works", () => {
    write("Same.json", { colors: { "editor.background": "#101014" } });
    service.import(join(src, "Same.json"));
    write("Same.json", { colors: { "editor.background": "#202028" } });
    service.import(join(src, "Same.json"));
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]!.seed.bg).toBe("#202028");
  });

  it("skips one unreadable theme rather than failing the whole list", () => {
    service.import(write("Good.json", { colors: { "editor.background": "#101014" } }));
    writeFileSync(join(home, "themes", "broken.json"), "{ this is not json");
    expect(service.list().map((t) => t.id)).toEqual(["good"]);
  });

  it("removes by id, and cannot be walked out of the folder by one", () => {
    service.import(write("Keep.json", { colors: { "editor.background": "#101014" } }));
    const outside = join(home, "secret.json");
    writeFileSync(outside, "{}");
    // THE MUTANT: join the raw id. An id is client-supplied and becomes a path here.
    service.remove("../secret");
    expect(existsSync(outside)).toBe(true);
    service.remove("keep");
    expect(service.list()).toEqual([]);
  });

  it("refuses a path that is not there, rather than writing an empty theme", () => {
    expect(() => service.import(join(src, "nope.json"))).toThrow(RpcError);
  });
});


describe("the editors' installed themes", () => {
  const extension = (dir: string, name: string, manifest: unknown, files: Record<string, unknown>, nls?: unknown) => {
    const root = join(dir, name);
    mkdirSync(join(root, "themes"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    if (nls) writeFileSync(join(root, "package.nls.json"), JSON.stringify(nls));
    for (const [file, body] of Object.entries(files)) writeFileSync(join(root, file), JSON.stringify(body));
    return root;
  };

  it("lists each folder's contributed themes with their face and editor, read from the manifest", () => {
    // THE MUTANTS: the `%key%` label shown raw; every theme called dark; a theme whose file is
    // missing offered anyway, which can only fail when picked.
    const cursor = tempDir("realm-themes-cursor-");
    extension(cursor, "teabyii.ayu-1.3.0", { contributes: { themes: [
      { label: "Ayu Light", uiTheme: "vs", path: "./themes/ayu-light.json" },
      { label: "Ayu Dark", uiTheme: "vs-dark", path: "./themes/ayu-dark.json" },
      { label: "Gone", uiTheme: "vs-dark", path: "./themes/gone.json" },
    ] } }, { "themes/ayu-light.json": { colors: {} }, "themes/ayu-dark.json": { colors: {} } });
    extension(cursor, "theme-defaults", { contributes: { themes: [{ label: "%darkModern%", uiTheme: "vs-dark", path: "./themes/dark_modern.json" }] } },
      { "themes/dark_modern.json": { colors: {} } }, { darkModern: "Dark Modern" });
    writeFileSync(join(cursor, "not-an-extension"), "");
    const themes = new ThemesService({ home, editorFolders: [{ editor: "Cursor", dir: cursor }, { editor: "VS Code", dir: join(cursor, "missing") }] });
    expect(themes.installed().map(({ label, mode, editor }) => ({ label, mode, editor }))).toEqual([
      { label: "Ayu Light", mode: "light", editor: "Cursor" },
      { label: "Ayu Dark", mode: "dark", editor: "Cursor" },
      { label: "Dark Modern", mode: "dark", editor: "Cursor" },
    ]);
    rmSync(cursor, { recursive: true, force: true });
  });

  it("leaves out a theme already imported, and a file reached through two folders is offered once", () => {
    const vscode = tempDir("realm-themes-vscode-");
    const root = extension(vscode, "nord", { contributes: { themes: [{ label: "Nord", uiTheme: "vs-dark", path: "./themes/nord.json" }] } },
      { "themes/nord.json": { name: "Nord", colors: { "editor.background": "#2e3440", "editor.foreground": "#d8dee9" } } });
    const themes = new ThemesService({ home, editorFolders: [{ editor: "VS Code", dir: vscode }, { editor: "VS Code", dir: vscode }] });
    expect(themes.installed().map((t) => t.label)).toEqual(["Nord"]);
    themes.import(join(root, "themes/nord.json"));
    expect(themes.installed()).toEqual([]);
    rmSync(vscode, { recursive: true, force: true });
  });
});
