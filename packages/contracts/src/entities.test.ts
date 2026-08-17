import { describe, expect, it } from "vitest";
import { newId } from "./ids";
import { ProfileSchema, SpaceSchema, ItemSchema } from "./entities";

describe("entities", () => {
  it("newId returns 26-char ULID", () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it("ProfileSchema accepts a valid profile", () => {
    const p = ProfileSchema.parse({
      id: newId(), name: "Work", icon: "briefcase", color: "#3366ff", sortOrder: 0,
      createdAt: 1, updatedAt: 1,
    });
    expect(p.name).toBe("Work");
  });
  it("SpaceSchema requires folderPath and defaults layout to null", () => {
    const s = SpaceSchema.parse({
      id: newId(), profileId: newId(), name: "Versed", icon: "folder", sortOrder: 0,
      folderPath: "/tmp/x", layout: null, activeItemId: null, createdAt: 1, updatedAt: 1,
    });
    expect(s.layout).toBeNull();
  });
  it("ItemSchema rejects unknown kind", () => {
    expect(() => ItemSchema.parse({
      id: newId(), spaceId: newId(), kind: "nope", title: "x", sortOrder: 0, pinned: false,
      refId: newId(), createdAt: 1, updatedAt: 1,
    })).toThrow();
  });
});
