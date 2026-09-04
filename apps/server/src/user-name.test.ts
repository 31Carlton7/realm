import { describe, expect, it } from "vitest";
import { firstName, userFirstName } from "./user-name";

describe("firstName", () => {
  it("takes the leading word of the directory record's real name", () => {
    expect(firstName("Carlton Aikins", "carltonaikins")).toBe("Carlton");
    expect(firstName("  Ada  Lovelace ", "ada")).toBe("Ada");
    expect(firstName("Prince", "prince2")).toBe("Prince");
    // A login name that IS the first name is the common case, not a missing record.
    expect(firstName("Ada Lovelace", "ada")).toBe("Ada");
  });
  it("reports no name when the record is empty or is only the login name", () => {
    expect(firstName("", "carltonaikins")).toBe("");
    expect(firstName("   ", "carltonaikins")).toBe("");
    expect(firstName("carltonaikins", "carltonaikins")).toBe("");
    expect(firstName("CarltonAikins", "carltonaikins")).toBe(""); // the same name, differently cased
  });
});

describe("userFirstName", () => {
  it("resolves a string on any host — a missing name is not an error", async () => {
    expect(typeof await userFirstName()).toBe("string");
  });
});
