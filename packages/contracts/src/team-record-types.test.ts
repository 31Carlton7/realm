import { describe, expect, it } from "vitest";
import { creatorRecordTemplate, parseAccount, parseRecord, type RecordLine } from "./team";
import {
  CREATOR_PRESET, CreateRecordTypeSchema, RECORD_PRESETS, RecordFolderSchema, parseEntry, recordEntries, recordPreset, recordSectionsByType,
  recordTemplate, recordTitle, recordToolDescriptions, recordsPreambleLine, typeNamesFromFolder,
} from "./team-record-types";

const line = (text: string): RecordLine => ({ text, meta: {}, field: null });

describe("the creator preset", () => {
  it("starts a record exactly as v50's creatorRecordTemplate did, byte for byte", () => {
    // THE mutant: a status other than the first, a section out of order, a missing trailing newline.
    for (const name of ["Nathan Beyenhof", "Zoë Ñ", "x"]) expect(recordTemplate(CREATOR_PRESET, name)).toBe(creatorRecordTemplate(name));
  });

  it("is the one preset in creators/, and every preset has a unique key and folder", () => {
    expect(recordPreset("creator")).toBe(CREATOR_PRESET);
    expect(new Set(RECORD_PRESETS.map((p) => p.key)).size).toBe(RECORD_PRESETS.length);
    expect(new Set(RECORD_PRESETS.map((p) => p.folder)).size).toBe(RECORD_PRESETS.length);
    for (const p of RECORD_PRESETS) expect(RecordFolderSchema.safeParse(p.folder).success, p.key).toBe(true);
  });
});

describe("a record from any type", () => {
  it("puts a head field named as the title under the title line, and a status only where one is kept", () => {
    const release = { titleField: "Version", statusField: "Status", statuses: ["planned", "live"], sections: [{ heading: "Changes", shape: "list" as const }] };
    expect(recordTemplate(release, "2.4.0")).toBe("# 2.4.0\n- Version: 2.4.0\n- Status: planned\n\n## Changes\n");
    expect(recordTemplate({ titleField: "#", statusField: null, statuses: [], sections: [] }, "Plain")).toBe("# Plain\n");
  });

  it("reads its name from the title line or from the head field the type names", () => {
    const r = parseRecord("# Release notes\n- Version: 2.4.0\n")!;
    expect(recordTitle({ titleField: "#" }, r)).toBe("Release notes");
    expect(recordTitle({ titleField: "Version" }, r)).toBe("2.4.0");
    expect(recordTitle({ titleField: "Missing" }, r)).toBe("Release notes");
  });

  it("lays a record's sections against its type, and keeps the ones it does not name under Other", () => {
    const r = parseRecord("# A\n\n## Deal\n- Rate: 5\n\n## Gossip\n- heard things\n")!;
    const out = recordSectionsByType(CREATOR_PRESET, r);
    expect(out.named.map((n) => [n.section.heading, n.lines.length])).toEqual([["Deal", 1], ["Accounts", 0], ["Deadlines", 0], ["Content", 0]]);
    expect(out.other.map((o) => o.heading)).toEqual(["Gossip"]);
  });
});

describe("parseEntry", () => {
  it("splits a line as v50's parseAccount did — the same channel, handle, parts and note", () => {
    const lines = [
      "TikTok @versed.nathan · vault: tiktok.com/nathan · device: lab-iphone-2 · consent: contract §4",
      "Instagram @versed.nathan · vault: instagram.com/nathan",
      "YouTube Shorts: waiting on Nathan",
      "Email · vault: gmail",
      "plain words",
    ];
    for (const text of lines) {
      const a = parseAccount(line(text));
      const e = parseEntry(line(text));
      expect({ channel: e.label, handle: e.handle, parts: e.parts, note: e.note }, text).toEqual(a);
    }
  });

  it("says which of the type's parts a line lacks", () => {
    expect(parseEntry(line("TikTok @a · vault: x"), ["vault", "device", "consent"]).missing).toEqual(["device", "consent"]);
    expect(recordEntries(parseRecord("# A\n\n## People\n- Dana · role: lead\n")!, "people", ["role"])[0]).toMatchObject({ label: "Dana", parts: { role: "lead" }, missing: [] });
  });
});

describe("what a role is told", () => {
  const V50 = "- Records are Markdown files under `creators/` in the team's memory. Read them with `record_list` and `record_read`; change them with `record_update`. An account names where its sign-in is kept, never a password or key.";
  const lead = recordPreset("lead")!;

  it("renders v50's records sentence exactly for one creator type", () => {
    expect(recordsPreambleLine([CREATOR_PRESET])).toBe(V50);
  });

  it("names every folder and its sections for several types, and says when none is kept", () => {
    expect(recordsPreambleLine([CREATOR_PRESET, lead])).toBe("- Records are Markdown files in the team's memory: `creators/` (Creator: Deal, Accounts, Deadlines, Content) and `leads/` (Lead: Notes, Touches). Read them with `record_list` and `record_read`; change them with `record_update`, naming the `type` when you make one. An account names where its sign-in is kept, never a password or key.");
    expect(recordsPreambleLine([lead])).toBe("- Records are Markdown files under `leads/` in the team's memory. Read them with `record_list` and `record_read`; change them with `record_update`. A record never holds a password or key.");
    expect(recordsPreambleLine([])).toMatch(/keeps no records yet/);
  });

  it("builds the record tools' words from the types: the sections to add to, and whether a type is needed", () => {
    const one = recordToolDescriptions([CREATOR_PRESET]);
    expect(one.section).toBe("op add: Deal, Accounts, Deadlines or Content; omit for the head");
    expect(one.read).toContain("its head (Status, Contact, Sends from), then ## Deal, ## Accounts, ## Deadlines, ## Content");
    expect(one.update).toContain("makes creators/<name>.md");
    expect(one.update).not.toContain("and `type`");
    const two = recordToolDescriptions([CREATOR_PRESET, lead]);
    expect(two.update).toContain("(with `name`, and `type`)");
    expect(two.section).toBe("op add: Deal, Accounts, Deadlines, Content, Notes or Touches; omit for the head");
    expect(two.path).toBe("creators/<name>.md or leads/<name>.md");
  });
});

describe("types named from a folder", () => {
  it("makes one and many from the folder's name", () => {
    expect(typeNamesFromFolder("leads")).toEqual({ key: "lead", one: "Lead", many: "Leads" });
    expect(typeNamesFromFolder("companies")).toEqual({ key: "company", one: "Company", many: "Companies" });
    expect(typeNamesFromFolder("boxes")).toEqual({ key: "box", one: "Box", many: "Boxes" });
    expect(typeNamesFromFolder("status")).toEqual({ key: "status", one: "Status", many: "Status" });
    expect(typeNamesFromFolder("press-kits")).toEqual({ key: "press-kit", one: "Press kit", many: "Press kits" });
  });
});

describe("the type schemas", () => {
  it("refuse a folder that is not one plain segment, or the memory repo's own", () => {
    for (const bad of ["a/b", "../x", ".git", "_tmpl", "imported", "Leads", "x.md", ""]) expect(RecordFolderSchema.safeParse(bad).success, bad).toBe(false);
    expect(RecordFolderSchema.safeParse("press-kits").success).toBe(true);
  });

  it("take a preset by key or a type written out", () => {
    expect(CreateRecordTypeSchema.safeParse({ spaceId: "01SP0000000000000000000001", preset: "lead" }).success).toBe(true);
    expect(CreateRecordTypeSchema.safeParse({ spaceId: "01SP0000000000000000000001", one: "Lead", many: "Leads", folder: "leads", sections: [{ heading: "Notes", shape: "text" }] }).success).toBe(true);
    expect(CreateRecordTypeSchema.safeParse({ spaceId: "01SP0000000000000000000001", one: "Lead", many: "Leads", folder: "leads", sections: [{ heading: "## Notes", shape: "text" }] }).success).toBe(false);
  });
});
