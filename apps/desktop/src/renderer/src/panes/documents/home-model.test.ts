import { describe, expect, it } from "vitest";
import { documentKindFor } from "@realm/contracts";
import { codeLanguageFor } from "./code-languages";
import {
  CODE_FILE_LANGUAGES, checkoutFileOf, homeFilesOf, identityOf, matchRun, placeFile, planNewFile, sessionDetail,
  tildePath, withExtension, withoutShown,
} from "./home-model";

const ROOT = "/Users/ada/work/yooo";

describe("where a listed file sits, relative to the pane", () => {
  it("opens a file inside the checkout as a tab, and keeps one outside it to its absolute path", () => {
    expect(placeFile(`${ROOT}/notes/plan.md`, ROOT)).toEqual({ rel: "notes/plan.md", abs: `${ROOT}/notes/plan.md` });
    // THE MUTANT: a prefix test without the slash, and a sibling checkout named like this one opens
    // as one of its tabs — `yoooo/` is not inside `yooo`.
    expect(placeFile(`${ROOT}o/plan.md`, ROOT)).toEqual({ rel: null, abs: `${ROOT}o/plan.md` });
    expect(placeFile("/Users/ada/Downloads/brief.pdf", ROOT)).toEqual({ rel: null, abs: "/Users/ada/Downloads/brief.pdf" });
    // A root given with its trailing slash is the same root.
    expect(placeFile(`${ROOT}/a.ts`, `${ROOT}/`)).toEqual({ rel: "a.ts", abs: `${ROOT}/a.ts` });
  });

  it("reads a relative path as the agent's own working directory, which is the checkout", () => {
    expect(placeFile("src/greet.ts", ROOT)).toEqual({ rel: "src/greet.ts", abs: `${ROOT}/src/greet.ts` });
    expect(placeFile("./README.md", ROOT)).toEqual({ rel: "README.md", abs: `${ROOT}/README.md` });
    // Out of it, and a `~` only main can expand: neither is a tab the pane could open.
    expect(placeFile("../other/x.md", ROOT)).toEqual({ rel: null, abs: null });
    expect(placeFile("~/x.md", ROOT)).toEqual({ rel: null, abs: null });
    expect(placeFile("src/greet.ts", null)).toEqual({ rel: "src/greet.ts", abs: null });
  });

  it("says where a session's file is the way a person reads it", () => {
    const at = (path: string) => placeFile(path, ROOT);
    expect(sessionDetail({ kind: "output" }, at(`${ROOT}/notes/plan.md`), `${ROOT}/notes/plan.md`)).toBe("notes");
    // At the checkout's top the name is the whole path, so there is nothing to add.
    expect(sessionDetail({ kind: "output" }, at(`${ROOT}/README.md`), `${ROOT}/README.md`)).toBe("");
    expect(sessionDetail({ kind: "output" }, at("/Users/ada/Desktop/x.md"), "/Users/ada/Desktop/x.md")).toBe("~/Desktop");
    // Where a pasted picture was written is a fact about Realm, not about the file.
    expect(sessionDetail({ kind: "upload" }, at("/Users/ada/Realm/tmp/attachments/a1-shot.png"), "/x")).toBe("Attached");
    expect(tildePath("/Users/ada")).toBe("~");
  });
});

describe("one file, listed once", () => {
  it("drops from a later list what an earlier one shows, by where the file IS", () => {
    const entry = (id: string, path: string) => ({ id, sessionId: "s", spaceId: "sp", kind: "output" as const, path, name: path.split("/").pop()!, ext: "md", ts: 1, sessionTitle: "T", agentKind: "fake" });
    // The same file, written by one session as a relative path and by another as an absolute one.
    const session = homeFilesOf([entry("a", "notes/plan.md")], ROOT, () => "");
    const library = homeFilesOf([entry("b", `${ROOT}/notes/plan.md`), entry("c", `${ROOT}/other.md`)], ROOT, (e) => e.sessionTitle);
    const shown = new Set(session.map(identityOf));
    expect(withoutShown(library, shown).map((f) => f.name)).toEqual(["other.md"]);
    expect(withoutShown([checkoutFileOf("notes/plan.md", ROOT)], shown)).toEqual([]);
  });

  it("marks the run of the name a search matched, and nothing when the name does not hold it", () => {
    expect(matchRun("launch-plan.md", "PLAN")).toEqual({ before: "launch-", match: "plan", after: ".md" });
    expect(matchRun("launch-plan.md", "lpm")).toBeNull();
    expect(matchRun("launch-plan.md", "  ")).toBeNull();
  });
});

describe("a new file, by its name", () => {
  it("lets the extension choose the editor", () => {
    expect(planNewFile("server.go")).toEqual({ ok: true, name: "server.go", kind: "code", says: "Opens in the code editor as Go" });
    expect(planNewFile("notes.md")).toMatchObject({ ok: true, kind: "doc", says: "Opens as a document" });
    expect(planNewFile("q3.csv")).toMatchObject({ ok: true, kind: "sheet" });
    expect(planNewFile(".gitignore")).toMatchObject({ ok: true, kind: "code" });
    // An extension the short list does not name still opens in the editor when the editor claims it;
    // one it has never heard of is refused rather than opened as a text file it might not be.
    expect(planNewFile("Cargo.lock")).toMatchObject({ ok: true, kind: "code", says: "Opens in the code editor" });
    expect(planNewFile("main.zig")).toMatchObject({ ok: false, says: "Realm has no editor for .zig files." });
  });

  it("waits on a name with no extension, and refuses what it cannot make here", () => {
    expect(planNewFile("server")).toBeNull();
    expect(planNewFile("   ")).toBeNull();
    expect(planNewFile("src/server.go")).toMatchObject({ ok: false });
    expect(planNewFile("archive.zip")).toMatchObject({ ok: false, says: "Realm has no editor for .zip files." });
    // A PDF or a picture is shown here and never written: it is not text.
    expect(planNewFile("shot.png")).toMatchObject({ ok: false });
    expect(planNewFile("brief.pdf")).toMatchObject({ ok: false });
    // THE MUTANT: check the name against the folder case-sensitively, on a filesystem that is not.
    expect(planNewFile("README.md", new Set(["readme.md"]))).toMatchObject({ ok: false, says: "README.md is already in this folder." });
  });

  it("swaps the extension and keeps the name — the language list's one move", () => {
    expect(withExtension("server.ts", "py")).toBe("server.py");
    expect(withExtension("deck.slides.md", "ts")).toBe("deck.ts");
    expect(withExtension("server", "go")).toBe("server.go");
    expect(withExtension("", "rs")).toBe("untitled.rs");
  });

  it("offers only languages the code editor claims and colours", () => {
    /* THE MUTANT: a language whose extension another editor claims (`.html` is the guide preview,
       `.md` the rich editor) or that has no grammar — the row would make a file that opens somewhere
       else, or opens grey. Plain text is the one row that is honestly grammar-less. */
    for (const { label, ext } of CODE_FILE_LANGUAGES) {
      expect(documentKindFor(`a.${ext}`), label).toBe("code");
      if (ext !== "txt") expect(codeLanguageFor(`a.${ext}`), label).not.toBe("text");
    }
    expect(new Set(CODE_FILE_LANGUAGES.map((l) => l.ext)).size).toBe(CODE_FILE_LANGUAGES.length);
  });
});
