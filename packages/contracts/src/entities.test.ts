import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { ItemKindSchema, PAGE_REF_IDS } from "./entities";
import { IdSchema } from "./ids";

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
    for (const id of ids) expect(id.startsWith("0000000000")).toBe(true); // ulid()'s first 10 chars encode NOW
    expect(ulid().startsWith("0000000000")).toBe(false);
  });
});
