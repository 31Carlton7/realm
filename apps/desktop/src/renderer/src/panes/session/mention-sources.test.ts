import { describe, expect, it } from "vitest";
import type { InstalledApp, LibraryEntry } from "@realm/contracts";
import { skillRow } from "../../state/store.test-fakes";
import { MAC_DETAIL, RANKED_CAPS, TOUR_CAPS, labelCandidatesFor, mentionOptions, mentionRows, refFor, type MentionOption } from "./mention-sources";

/**
 * The `@` list's order, as a pure function of what each source answered. What must die: a kind that
 * floods a typed answer, a tie that reorders between keystrokes, @Mac listed twice, a secret or a
 * duplicate offered, and the tour losing its heads or its Dock order.
 */

const app = (name: string, bundleId: string, extra: Partial<InstalledApp> = {}): InstalledApp =>
  ({ name, bundleId, path: `/Applications/${name}.app`, aliases: [], dock: null, ...extra });
const entry = (name: string, path: string, sessionTitle = "Report"): LibraryEntry =>
  ({ id: path, sessionId: "s", spaceId: "sp", kind: "output", path, name, ext: "", ts: 1, sessionTitle, agentKind: "claude" });

const options = (over: Partial<Parameters<typeof mentionOptions>[0]> = {}) => mentionOptions({
  mac: skillRow("mac"),
  skills: [skillRow("mac"), skillRow("notes"), skillRow("review", { name: "Code review" })],
  files: [{ path: "src/messages/store.ts" }, { path: "src/auth.ts" }, { path: "lib/message-queue.ts" }, { path: ".env.local" }],
  cwd: "/repo/",
  library: [entry("messages-export.csv", "/out/messages-export.csv"), entry("auth.ts", "/repo/src/auth.ts"), entry("rel.md", "rel.md")],
  apps: [app("Mail", "com.apple.mail", { dock: 2 }), app("Messages", "com.apple.MobileSMS", { dock: 0 }), app("Maps", "com.apple.Maps"), app("Visual Studio Code", "com.microsoft.VSCode", { aliases: ["Code"] })],
  ...over,
});
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("what the @ list can name", () => {
  it("joins the sources, lists @Mac once as itself, and never offers a secret, a duplicate or a relative path", () => {
    const all = options();
    expect(all.filter((o) => o.kind === "mac")).toHaveLength(1);
    expect(all.filter((o) => o.kind === "skill").map((o) => o.name)).toEqual(["notes", "review"]); // THE twice-listed mutant: `mac` here too
    expect(all.some((o) => o.name === ".env.local")).toBe(false);
    // The Library's copy of a file in this checkout is the same file, listed once, as the file; a
    // relative Library path names nothing a mention could hand over.
    expect(all.filter((o) => o.kind === "library").map((o) => o.name)).toEqual(["messages-export.csv"]);
    expect(all.find((o) => o.kind === "file" && o.name === "auth.ts")).toMatchObject({ path: "/repo/src/auth.ts", rel: "src/auth.ts" });
  });

  it("says a file the person added to the Library was added, where the others name a session", () => {
    // THE mutant: the session title read off an added file, which has none — a row reading "null".
    const scan: LibraryEntry = { id: "f1", sessionId: null, spaceId: null, kind: "added", path: "/realm-home/library/p1/scan.pdf", name: "scan.pdf", ext: "pdf", ts: 1, sessionTitle: null, agentKind: null };
    const rows = options({ library: [scan, entry("brief.md", "/out/brief.md", "Pricing page")] }).filter((o) => o.kind === "library");
    expect(rows.map((o) => [o.name, o.kind === "library" ? o.from : null])).toEqual([["scan.pdf", "Added by you"], ["brief.md", "Pricing page"]]);
  });

  it("turns a pick into the sidecar entry it stands for, and @Mac and skills into none", () => {
    const by = (kind: MentionOption["kind"]) => options().find((o) => o.kind === kind)!;
    expect(refFor(by("file"))).toEqual({ kind: "file", path: "/repo/src/messages/store.ts" });
    expect(refFor(by("library"))).toEqual({ kind: "library", path: "/out/messages-export.csv" });
    expect(refFor(by("app"))).toEqual({ kind: "app", name: "Mail", bundleId: "com.apple.mail", path: "/Applications/Mail.app" });
    expect(refFor(by("mac"))).toBeNull();
    expect(refFor(by("skill"))).toBeNull();
    expect(labelCandidatesFor(by("file"))).toEqual(["store.ts", "messages/store.ts", "src/messages/store.ts"]);
  });
});

describe("a bare @: the tour", () => {
  it("leads with @Mac on its own, then each kind under its head, a few of each", () => {
    const rows = mentionRows(options(), "");
    expect(rows[0]).toMatchObject({ kind: "mac", detail: MAC_DETAIL });
    expect(rows[0]!.head).toBeUndefined();
    expect(rows.filter((r) => r.head).map((r) => r.head)).toEqual(["Files", "Library", "Skills", "Apps"]);
    for (const kind of ["file", "library", "skill", "app"] as const) {
      expect(rows.filter((r) => r.kind === kind).length).toBeLessThanOrEqual(TOUR_CAPS[kind]);
    }
  });

  it("orders apps by the Dock, then by name — the apps a person keeps are the ones they mention", () => {
    expect(names(mentionRows(options(), "").filter((r) => r.kind === "app"))).toEqual(["Messages", "Mail", "Maps", "Visual Studio Code"]);
  });

  it("names a file's folder, a Library file's session, and leaves the kind to the heads", () => {
    const rows = mentionRows(options(), "");
    expect(rows.find((r) => r.name === "store.ts")!.detail).toBe("src/messages");
    expect(rows.find((r) => r.name === "messages-export.csv")!.detail).toBe("Report");
    expect(rows.find((r) => r.name === "Messages")!.detail).toBe("Computer use");
  });
});

describe("a typed word: one ranked list", () => {
  it("puts the best match first whatever its kind, and says what each row is", () => {
    const rows = mentionRows(options(), "mes");
    expect(rows[0]).toMatchObject({ kind: "app", name: "Messages", detail: "Computer use" });
    expect(rows.map((r) => r.kind)).toContain("file");
    expect(rows.find((r) => r.name === "store.ts")!.detail).toBe("File · src/messages");
    expect(rows.find((r) => r.kind === "library")!.detail).toBe("Library · Report");
  });

  it("finds an app by the other names it answers to, and a skill by its display name", () => {
    expect(names(mentionRows(options(), "code"))[0]).toBe("Visual Studio Code");
    expect(names(mentionRows(options(), "Code r"))).toContain("review");
  });

  it("ranks a match in a file's name over one in its folder", () => {
    const rows = mentionRows(options(), "mes");
    expect(rows.findIndex((r) => r.name === "message-queue.ts")).toBeLessThan(rows.findIndex((r) => r.name === "store.ts"));
  });

  it("does not hold an app's capital letter against it", () => {
    // THE case mutant: score only as typed, and the lowercase file name wins on case agreement.
    expect(names(mentionRows(options({ files: [] }), "mes")).slice(0, 2)).toEqual(["Messages", "messages-export.csv"]);
  });

  it("caps each kind, so a thousand weak files cannot push every app off the list", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ path: `src/m${i}/a.ts` }));
    const rows = mentionRows(options({ files: many }), "m");
    expect(rows.filter((r) => r.kind === "file")).toHaveLength(RANKED_CAPS.file);
    expect(rows.some((r) => r.kind === "app")).toBe(true);
  });

  it("breaks ties the same way every time — no row trades places between keystrokes", () => {
    const a = names(mentionRows(options(), "ma"));
    const b = names(mentionRows(options({ apps: [...options().filter((o) => o.kind === "app").map((o) => (o as Extract<MentionOption, { kind: "app" }>).app)].reverse() }), "ma"));
    expect(b).toEqual(a);
    // Equal scores go to the kind that names a capability, then to the shorter name.
    expect(a.indexOf("Mail")).toBeLessThan(a.indexOf("Maps") + 1);
  });

  it("matches nothing for a word nothing contains", () => {
    expect(mentionRows(options(), "zzzz")).toEqual([]);
  });

  it("tells an app row that macOS has not let Realm drive it", () => {
    expect(mentionRows(options(), "mail", { accessibility: false }).find((r) => r.name === "Mail")!.detail).toBe("Computer use · needs Accessibility");
    expect(mentionRows(options(), "mail", { accessibility: null }).find((r) => r.name === "Mail")!.detail).toBe("Computer use");
  });
});
