import { describe, expect, it } from "vitest";
import { memoryLibraryId, parseMemoryLibraryId } from "./memory-library";

describe("memory library ids", () => {
  it("splits at the first colon, so a path may hold one", () => {
    const id = memoryLibraryId("realm-repo-profile-01", "spaces/realm/a:b.md");
    expect(parseMemoryLibraryId(id)).toEqual({ sourceId: "realm-repo-profile-01", rel: "spaces/realm/a:b.md" });
    expect(parseMemoryLibraryId("no-colon")).toBeNull();
    expect(parseMemoryLibraryId(":rel.md")).toBeNull();
    expect(parseMemoryLibraryId("source:")).toBeNull();
  });
});
