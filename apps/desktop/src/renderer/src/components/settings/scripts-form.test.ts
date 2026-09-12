import { describe, expect, it } from "vitest";
import type { Script } from "@realm/contracts";
import { draftFrom, emptyDraft, reorderedIds, validateScriptDraft } from "./scripts-form";

const script = (id: string, over: Partial<Script> = {}): Script =>
  ({ id, name: `Script ${id}`, command: "pnpm test", cwd: null, ...over });

describe("validateScriptDraft", () => {
  it("takes a filled-in draft and hands back what the RPC wants", () => {
    const v = validateScriptDraft({ id: null, name: "  Test  ", command: "  pnpm test  ", cwd: " apps/server " });
    expect(v.ok).toBe(true);
    // Trimmed by the schema, not by the form: one place decides what a stored name looks like.
    if (v.ok) expect(v.input).toEqual({ id: null, name: "Test", command: "pnpm test", cwd: "apps/server" });
  });

  it("a blank folder is null, never the empty string", () => {
    /* THE MUTANT: pass `draft.cwd.trim()` straight through. `cwd: ""` is a relative path of nothing,
       which the server resolves against the space folder by accident rather than by the rule that
       says null MEANS the space folder — and the row then prints "in ''" as if the user chose it. */
    const v = validateScriptDraft({ ...emptyDraft(), name: "Test", command: "pnpm test", cwd: "   " });
    expect(v.ok && v.input.cwd).toBeNull();
  });

  it("refuses a blank name in Realm's own words, and points at the field", () => {
    const v = validateScriptDraft({ id: null, name: "   ", command: "pnpm test", cwd: "" });
    expect(v).toEqual({ ok: false, field: "name", message: "Give the script a name." });
  });

  it("refuses a blank command the same way", () => {
    const v = validateScriptDraft({ id: null, name: "Test", command: "  ", cwd: "" });
    expect(v).toEqual({ ok: false, field: "command", message: "A script needs a command to run." });
  });

  it("names the cap when the name is over it, rather than going quiet", () => {
    /* The case a disabled Save button cannot explain: 80 characters and 81 look identical, so the
       only useful thing to say is the number. THE MUTANT: return the schema's own
       "String must contain at most 80 character(s)" — true, and not a sentence this app writes. */
    const v = validateScriptDraft({ id: null, name: "x".repeat(81), command: "pnpm test", cwd: "" });
    expect(v).toEqual({ ok: false, field: "name", message: "A name is at most 80 characters." });
  });

  it("carries an id through, which is what makes a save an UPDATE", () => {
    /* THE MUTANT: drop `id` from the parsed object. Every edit then creates a second script, and the
       `script.<id>.run` binding someone wrote stays attached to the abandoned original. */
    const id = `01HQ${"0".repeat(22)}`;
    const v = validateScriptDraft({ id, name: "Test", command: "pnpm test", cwd: "" });
    expect(v.ok && v.input.id).toBe(id);
  });

  it("draftFrom round-trips an existing script, with a null folder shown as blank", () => {
    expect(draftFrom(script("A"))).toEqual({ id: "A", name: "Script A", command: "pnpm test", cwd: "" });
    expect(draftFrom(script("A", { cwd: "apps/server" })).cwd).toBe("apps/server");
  });
});

describe("reorderedIds", () => {
  const list = [script("A"), script("B"), script("C")];

  it("moves one place up and one place down, leaving everything else in order", () => {
    expect(reorderedIds(list, 1, -1)).toEqual(["B", "A", "C"]);
    expect(reorderedIds(list, 1, 1)).toEqual(["A", "C", "B"]);
  });

  it("refuses a move off either end instead of sending a no-op write", () => {
    /* THE MUTANT: clamp instead of refusing. The call goes out, the server writes the list it already
       had, the page redraws unchanged — and the user, who pressed "Move up" on the first row, reads
       that as the control being broken rather than as there being nowhere to go. */
    expect(reorderedIds(list, 0, -1)).toBeNull();
    expect(reorderedIds(list, 2, 1)).toBeNull();
    expect(reorderedIds(list, 5, -1)).toBeNull();
  });
});
