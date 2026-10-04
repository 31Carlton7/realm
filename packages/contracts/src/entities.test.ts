import { describe, expect, it } from "vitest";
import { newId, IdSchema } from "./ids";
import { ProfileSchema, SpaceSchema, ItemSchema, ItemKindSchema, PAGE_REF_IDS, FAVICON_MAX_BYTES, isFaviconDataUrl } from "./entities";

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
      browserPartition: "persist:browser", createdAt: 1, updatedAt: 1,
    });
    expect(p.name).toBe("Work");
  });
  it("ProfileSchema requires the profile's browser partition — main cannot place a pane without it", () => {
    const base = { id: newId(), name: "Work", icon: "briefcase", color: "#3366ff", sortOrder: 0, createdAt: 1, updatedAt: 1 };
    expect(ProfileSchema.safeParse(base).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...base, browserPartition: "persist:browser-x" }).success).toBe(true);
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

describe("isFaviconDataUrl — what a browser row may keep as its icon", () => {
  const b64 = (n: number) => Buffer.alloc(n, 7).toString("base64");

  it("takes the picture itself, base64, in one of the formats main recognises", () => {
    expect(isFaviconDataUrl(`data:image/png;base64,${b64(64)}`)).toBe(true);
    expect(isFaviconDataUrl(`data:image/x-icon;base64,${b64(64)}`)).toBe(true);
    expect(isFaviconDataUrl(`data:image/svg+xml;base64,${b64(64)}`)).toBe(true);
  });

  it("never an address: the window would have to fetch it, and its CSP admits no remote image", () => {
    // THE MUTANT: accept anything that names an image. A row holding a URL would have every tab ask
    // the site for it from the app's own session, days later, from a list the reader is scanning.
    expect(isFaviconDataUrl("https://www.google.com/favicon.ico")).toBe(false);
    expect(isFaviconDataUrl("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")).toBe(false); // not base64
  });

  it("nothing that is not a picture, and nothing past the bound", () => {
    expect(isFaviconDataUrl(`data:text/html;base64,${b64(64)}`)).toBe(false);
    expect(isFaviconDataUrl("data:image/png;base64,")).toBe(false);
    expect(isFaviconDataUrl(`data:image/png;base64,${b64(FAVICON_MAX_BYTES)}`)).toBe(true);
    // THE MUTANT: no bound. The icon rides on every item list the sidebar fetches.
    expect(isFaviconDataUrl(`data:image/png;base64,${b64(FAVICON_MAX_BYTES + 3)}`)).toBe(false);
  });
});

describe("destination-page sentinels (Plan 12 W4)", () => {
  it("every page kind in PAGE_REF_IDS is a real item kind", () => {
    for (const kind of Object.keys(PAGE_REF_IDS)) expect(ItemKindSchema.safeParse(kind).success).toBe(true);
  });

  it("each sentinel passes IdSchema — items.create must accept it as a refId", () => {
    for (const id of Object.values(PAGE_REF_IDS)) expect(IdSchema.safeParse(id).success).toBe(true);
  });

  it("profile-page (Plan 14 W2) took the next free sentinel — …005 — without colliding with an existing one", () => {
    expect(PAGE_REF_IDS["profile-page"]).toBe("00000000000000000000000005");
    expect(Object.entries(PAGE_REF_IDS).filter(([k]) => k !== "profile-page").map(([, v]) => v)).not.toContain("00000000000000000000000005");
  });

  it("sentinels are distinct, and unmintable: their timestamp component is the 1970 epoch", () => {
    const ids = Object.values(PAGE_REF_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("0000000000")).toBe(true); // newId()'s first 10 chars encode NOW
    expect(newId().startsWith("0000000000")).toBe(false);
  });
});
