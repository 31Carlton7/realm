import { describe, expect, it } from "vitest";
import { CODE_LANGUAGES, codeLanguageFor, extensionOf } from "./code-languages";

describe("extensionOf", () => {
  it("takes the last dot of the file name, lowercased", () => {
    expect(extensionOf("src/App.TSX")).toBe("tsx");
    expect(extensionOf("a/b/types.d.ts")).toBe("ts");
    expect(extensionOf("bundle.min.js")).toBe("js");
  });
  it("reads a dotfile's name as its extension, the way documentKindFor does", () => {
    // `.gitignore` has no stem, so the whole name after the dot is what both tables see.
    expect(extensionOf(".gitignore")).toBe("gitignore");
  });
  it("has no extension for a file with no dot", () => {
    // The honest limit of extension-driven detection: `Dockerfile`, `Makefile` and `LICENSE` are
    // real files with real grammars and nothing to key on.
    expect(extensionOf("Dockerfile")).toBe("");
    expect(extensionOf("src/Makefile")).toBe("");
  });
});

describe("codeLanguageFor", () => {
  it("covers the languages this repo is written in", () => {
    expect(codeLanguageFor("apps/server/src/app.ts")).toBe("typescript");
    expect(codeLanguageFor("src/App.tsx")).toBe("tsx");
    expect(codeLanguageFor("package.json")).toBe("json");
    expect(codeLanguageFor("README.md")).toBe("markdown");
    expect(codeLanguageFor("src/styles.css")).toBe("css");
    expect(codeLanguageFor("index.html")).toBe("html");
    expect(codeLanguageFor("scripts/build.py")).toBe("python");
    expect(codeLanguageFor("scripts/release.sh")).toBe("shell");
    expect(codeLanguageFor(".github/workflows/ci.yml")).toBe("yaml");
  });
  it("distinguishes the JavaScript family rather than lumping it", () => {
    // Four grammars, not one: the JSX parser accepts `<div/>` and the TS parser accepts `x as Y`,
    // and a file highlighted by the wrong one is a file full of red.
    expect(codeLanguageFor("a.mjs")).toBe("javascript");
    expect(codeLanguageFor("a.jsx")).toBe("jsx");
    expect(codeLanguageFor("a.mts")).toBe("typescript");
    expect(codeLanguageFor("a.tsx")).toBe("tsx");
  });
  it("sends a .h to C rather than C++", () => {
    // A C++ header still parses as C++ under the C grammar's tolerant path; a C file under the C++
    // grammar does not. The asymmetry is the reason this entry is not just "the cpp mode".
    expect(codeLanguageFor("include/queue.h")).toBe("c");
    expect(codeLanguageFor("include/queue.hpp")).toBe("cpp");
  });
  it("calls a file it knows to be text but has no grammar for text", () => {
    expect(codeLanguageFor("notes.txt")).toBe("text");
    expect(codeLanguageFor(".gitignore")).toBe("text");
  });
  it("falls back to text for an extension it has never seen", () => {
    expect(codeLanguageFor("x.frobnicate")).toBe("text");
    expect(codeLanguageFor("LICENSE")).toBe("text");
  });
  it("is case-insensitive about the extension and ignores the directory", () => {
    expect(codeLanguageFor("PY/Scripts/MAIN.PY")).toBe("python");
    expect(codeLanguageFor("py/notes.md")).toBe("markdown");
  });
  it("lists every grammar the table can ask for, once", () => {
    expect(new Set(CODE_LANGUAGES).size).toBe(CODE_LANGUAGES.length);
    expect(CODE_LANGUAGES).toContain("text");
    // The loader switches on this list; a grammar in the table and missing from it would be a file
    // that silently opens grey.
    for (const path of ["a.ts", "a.rs", "a.go", "a.swift", "a.sql", "a.toml", "a.diff"]) {
      expect(CODE_LANGUAGES).toContain(codeLanguageFor(path));
    }
  });
});
