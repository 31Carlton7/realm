import { describe, expect, it } from "vitest";
import { LIBRARY_ADD_MAX, type LibraryAddResult, type LibraryEntry } from "@realm/contracts";
import { folderOffer, folderOfferText, libraryAddNotices, nameList } from "./library-add";

const added = (name: string): LibraryEntry => ({ id: name, sessionId: null, spaceId: null, kind: "added", path: `/lib/${name}`, name, ext: "png", ts: 1, sessionTitle: null, agentKind: null });
const result = (over: Partial<LibraryAddResult>): LibraryAddResult => ({ added: [], renamed: [], skipped: [], folders: [], ...over });
const skip = (name: string, reason: LibraryAddResult["skipped"][number]["reason"], extra: { size?: number; existing?: string } = {}) =>
  ({ name, reason, size: extra.size ?? null, existing: extra.existing ?? null });
const folder = (name: string, files: number, extra: Partial<LibraryAddResult["folders"][number]> = {}) =>
  ({ path: `/Users/me/${name}`, name, files, bytes: files * 1024, subfolders: 0, more: false, ...extra });

describe("what an add says", () => {
  it("says what came in once, and names a copy kept under another name", () => {
    expect(libraryAddNotices(result({ added: [added("a.png")] }))).toEqual([{ tone: "success", text: "Added a.png to the Library." }]);
    expect(libraryAddNotices(result({ added: [added("a.png"), added("report 2.pdf")], renamed: [{ from: "report.pdf", to: "report 2.pdf" }] })))
      .toEqual([{ tone: "success", text: "Added 2 files to the Library. report.pdf is kept as report 2.pdf, beside the file of that name already there." }]);
  });

  it("says a file is already there, under the name the Library has for it", () => {
    expect(libraryAddNotices(result({ skipped: [skip("copy.png", "duplicate", { existing: "photo.png" })] })))
      .toEqual([{ tone: "info", text: "copy.png is already in the Library, as photo.png." }]);
    expect(libraryAddNotices(result({ skipped: [skip("photo.png", "duplicate", { existing: "photo.png" })] }))[0]!.text).toBe("photo.png is already in the Library.");
    expect(libraryAddNotices(result({ skipped: ["a", "b", "c", "d"].map((n) => skip(n, "duplicate")) }))[0]!.text).toBe("Already in the Library: a, b and 2 more.");
  });

  it("puts every refusal in ONE warning, each with its reason — never a toast per file", () => {
    /* THE mutant: a toast per file. A drop of forty files that are all too large is forty toasts, and
       the stack keeps three. */
    const notices = libraryAddNotices(result({ skipped: [skip("movie.mov", "too-large", { size: 30 * 1024 * 1024 }), skip("alias.png", "link"), skip("locked.key", "unreadable")] }));
    expect(notices).toEqual([{ tone: "warning", text: "Too large to add — the limit is 20 MB: movie.mov (30 MB). alias.png is a link, which Realm doesn't follow. Add the file itself. Couldn't read locked.key." }]);
  });

  it("lists names the way a person reads a short list", () => {
    expect(nameList(["a"])).toBe("a");
    expect(nameList(["a", "b"])).toBe("a and b");
    expect(nameList(["a", "b", "c"])).toBe("a, b and c");
    expect(nameList(["a", "b", "c", "d", "e"])).toBe("a, b and 3 more");
  });
});

describe("what a dropped folder becomes", () => {
  it("an offer for the folders whose files can be added, and a reason at once for those that cannot", () => {
    const { offer, notices } = folderOffer([folder("shots", 3), folder("empty", 0), folder("dump", LIBRARY_ADD_MAX + 1, { more: true }), folder("nested", 0, { subfolders: 2 })]);
    expect(offer?.map((f) => f.name)).toEqual(["shots"]);
    expect(notices.map((n) => [n.tone, n.text])).toEqual([
      ["info", "“empty” has no files in it to add."],
      ["warning", `“dump” holds more files than the Library takes at once (${LIBRARY_ADD_MAX}). Add the ones you want from inside it.`],
      ["info", "“nested” holds only folders, so there is nothing in it to add."],
    ]);
  });

  it("no offer for folders that together hold more than one add takes — the server would refuse it", () => {
    const half = Math.ceil(LIBRARY_ADD_MAX / 2) + 1;
    const { offer, notices } = folderOffer([folder("one", half), folder("two", half)]);
    expect(offer).toBeNull();
    expect(notices[0]!.text).toContain(`Those folders hold ${half * 2} files`);
  });

  it("says what adding would copy in, and what it leaves out", () => {
    expect(folderOfferText([folder("shots", 2, { subfolders: 1 })])).toBe("“shots” is a folder of 2 files (2.0 KB). Add them to the Library? The folders inside it are left out.");
    expect(folderOfferText([folder("shots", 1)])).toBe("“shots” is a folder of 1 file (1.0 KB). Add it to the Library?");
    expect(folderOfferText([folder("a", 2), folder("b", 3)])).toBe("These 2 folders hold 5 files (5.0 KB). Add them to the Library?");
  });
});
