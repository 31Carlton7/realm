import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  it("reads name and description out of a normal SKILL.md", () => {
    expect(parseFrontmatter("---\nname: mac\ndescription: Drives native macOS apps.\n---\n\n# body\n"))
      .toEqual({ name: "mac", description: "Drives native macOS apps." });
  });

  it("keeps colons inside a value", () => {
    // Real descriptions are full sentences and routinely contain a colon; splitting on the last one, or on
    // every one, silently truncates them.
    expect(parseFrontmatter("---\ndescription: Use when: the task touches Calendar.\n---\n")!.description)
      .toBe("Use when: the task touches Calendar.");
  });

  it("strips one layer of quotes", () => {
    expect(parseFrontmatter("---\nname: \"mac\"\ndescription: 'x'\n---\n")).toEqual({ name: "mac", description: "x" });
  });

  it("returns null for a file with no frontmatter fence", () => {
    expect(parseFrontmatter("# just a document\n")).toBeNull();
    expect(parseFrontmatter("")).toBeNull();
  });

  it("returns null when the fence never closes", () => {
    expect(parseFrontmatter("---\nname: mac\ndescription: x\n")).toBeNull();
  });

  it("reads a folded block scalar as one line", () => {
    const fm = parseFrontmatter("---\nname: mac\ndescription: >-\n  Use when the task\n  touches Calendar.\n---\n");
    expect(fm).toEqual({ name: "mac", description: "Use when the task touches Calendar." });
  });

  it("reads a literal block scalar keeping its line breaks", () => {
    const fm = parseFrontmatter("---\nname: mac\ndescription: |\n  one\n  two\n---\n");
    expect(fm!.description).toBe("one\ntwo");
  });

  it("ignores nested mappings and list items rather than flattening them into top-level keys", () => {
    const fm = parseFrontmatter("---\nname: mac\nmetadata:\n  author: someone\nallowed-tools:\n  - Bash\ndescription: x\n---\n");
    expect(fm).toEqual({ name: "mac", metadata: "", "allowed-tools": "", description: "x" });
  });

  it("survives an empty frontmatter block", () => {
    expect(parseFrontmatter("---\n---\n# body")).toEqual({});
  });

  it("accepts a `...` terminator and a leading BOM", () => {
    expect(parseFrontmatter("﻿---\nname: mac\n...\n")).toEqual({ name: "mac" });
  });
});
