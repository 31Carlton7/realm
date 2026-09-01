import { describe, expect, it } from "vitest";
import { newId, IdSchema } from "./ids";
import { ProfileSchema, SpaceSchema, ItemSchema, ItemKindSchema, PAGE_REF_IDS } from "./entities";

describe("entities", () => {
  it("newId returns 26-char ULID", () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("IdSchema accepts ULIDs and rejects non-Crockford 26-char strings", () => {
    expect(IdSchema.safeParse(newId()).success).toBe(true);
    expect(IdSchema.safeParse("a".repeat(26)).success).toBe(false);
    expect(IdSchema.safeParse("I".repeat(26)).success).toBe(false);
    expect(IdSchema.safeParse("0".repeat(25)).success).toBe(false);
  });
  it("ProfileSchema accepts a valid profile", () => {
    const p = ProfileSchema.parse({
      id: newId(), name: "Work", icon: "briefcase", color: "#3366ff", sortOrder: 0,
      createdAt: 1, updatedAt: 1,
    });
    expect(p.name).toBe("Work");
  });
  it("SpaceSchema accepts null layout", () => {
    const s = SpaceSchema.parse({
      id: newId(), profileId: newId(), name: "Versed", icon: "folder", color: "#7c6cff", sortOrder: 0,
      folderPath: "/tmp/x", layout: null, activeItemId: null, createdAt: 1, updatedAt: 1,
    });
    expect(s.layout).toBeNull();
  });
  it("SpaceSchema requires a #rrggbb color", () => {
    const base = { id: newId(), profileId: newId(), name: "V", icon: "folder", sortOrder: 0, folderPath: "/tmp/x", layout: null, activeItemId: null, createdAt: 1, updatedAt: 1 };
    expect(SpaceSchema.safeParse({ ...base, color: "#ABCDEF" }).success).toBe(true);
    expect(SpaceSchema.safeParse({ ...base, color: "#abc" }).success).toBe(false);
    expect(SpaceSchema.safeParse({ ...base, color: "red" }).success).toBe(false);
  });
  it("ItemSchema rejects unknown kind", () => {
    expect(() => ItemSchema.parse({
      id: newId(), spaceId: newId(), kind: "nope", title: "x", sortOrder: 0, pinned: false,
      refId: newId(), createdAt: 1, updatedAt: 1,
    })).toThrow();
  });
});

describe("destination-page sentinels (Plan 12 W4)", () => {
  it("every page kind in PAGE_REF_IDS is a real item kind", () => {
    for (const kind of Object.keys(PAGE_REF_IDS)) expect(ItemKindSchema.safeParse(kind).success).toBe(true);
  });

  it("each sentinel passes IdSchema — items.create must accept it as a refId", () => {
    for (const id of Object.values(PAGE_REF_IDS)) expect(IdSchema.safeParse(id).success).toBe(true);
  });

  it("sentinels are distinct, and unmintable: their timestamp component is the 1970 epoch", () => {
    const ids = Object.values(PAGE_REF_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("0000000000")).toBe(true); // newId()'s first 10 chars encode NOW
    expect(newId().startsWith("0000000000")).toBe(false);
  });
});
