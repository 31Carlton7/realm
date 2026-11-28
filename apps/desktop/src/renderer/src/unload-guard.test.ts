import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { unloadRefusal } from "./unload-guard";
import { holdOpenBuffers, keepTyping, forgetAllKeptTyping } from "./panes/documents/kept-typing";
import { opened, edited } from "./panes/documents/buffers";
import { forgetHeld, useReviewDraft } from "./panes/code-review/held";
import { EMPTY_DRAFT } from "./panes/code-review/code-review-model";

/**
 * A window main unloads gives up its renderer, and with it everything held only there. What must die:
 * any one of these left out, so a window with an unsent prompt, a file the reader has not settled or a
 * review half written goes for having been left alone, and the work with it.
 */
const nothing = { drafts: {}, pendingAttachments: {}, commitMessages: {} };

describe("a window holding work kept nowhere else", () => {
  afterEach(() => { forgetAllKeptTyping(); forgetHeld(); document.body.innerHTML = ""; });

  it("unloads when it holds nothing", () => {
    expect(unloadRefusal(nothing, document)).toBeNull();
    // Empty or blank drafts, and lists with nothing in them, are nothing.
    expect(unloadRefusal({ drafts: { s1: "", s2: "  \n" }, pendingAttachments: { s1: [] }, commitMessages: { "/w": "" } }, document)).toBeNull();
  });

  it("refuses with a prompt typed and not sent", () => {
    expect(unloadRefusal({ ...nothing, drafts: { s1: "draft the release notes" } }, document)).toBe("unsaved");
  });

  it("refuses with an attachment picked and not sent", () => {
    expect(unloadRefusal({ ...nothing, pendingAttachments: { s1: [{ name: "shot.png" }] } }, document)).toBe("unsaved");
  });

  it("refuses with a commit message written and not committed", () => {
    expect(unloadRefusal({ ...nothing, commitMessages: { "/work/realm": "Fix the idle sweep" } }, document)).toBe("unsaved");
  });

  it("refuses with a code review being written", () => {
    const { result } = renderHook(() => useReviewDraft("pr:1"));
    expect(unloadRefusal(nothing, document)).toBeNull();
    act(() => result.current[1]({ ...EMPTY_DRAFT, body: "The sweep needs a test" }));
    expect(unloadRefusal(nothing, document)).toBe("unsaved");
  });

  it("refuses with typing in an open document, in conflict, or deleted under the reader", () => {
    const clean = opened("a.md", "hello", "h1");
    const off = holdOpenBuffers("docs-1", () => [clean]);
    expect(unloadRefusal(nothing, document)).toBeNull();
    off();
    const typed = edited(clean, "hello there");
    const offTyped = holdOpenBuffers("docs-1", () => [typed]);
    expect(unloadRefusal(nothing, document)).toBe("unsaved");
    offTyped();
    const offConflict = holdOpenBuffers("docs-1", () => [{ ...clean, conflict: { theirs: "theirs", theirHash: "h2" } }]);
    expect(unloadRefusal(nothing, document)).toBe("unsaved");
    offConflict();
    const offMissing = holdOpenBuffers("docs-1", () => [{ ...clean, missing: true }]);
    expect(unloadRefusal(nothing, document)).toBe("unsaved");
    offMissing();
    expect(unloadRefusal(nothing, document)).toBeNull();
  });

  it("refuses with typing kept from a documents pane no longer on screen", () => {
    keepTyping("docs-2", edited(opened("b.md", "x", "h"), "xy"));
    expect(unloadRefusal(nothing, document)).toBe("unsaved");
  });

  it("refuses while a sheet or a dialog is open", () => {
    document.body.innerHTML = `<div role="dialog" aria-modal="true">Delete space?</div>`;
    expect(unloadRefusal(nothing, document)).toBe("unsaved");
    document.body.innerHTML = `<div role="alertdialog">Discard?</div>`;
    expect(unloadRefusal(nothing, document)).toBe("unsaved");
    document.body.innerHTML = `<dialog open>Settings</dialog>`;
    expect(unloadRefusal(nothing, document)).toBe("unsaved");
    document.body.innerHTML = `<dialog>closed</dialog>`;
    expect(unloadRefusal(nothing, document)).toBeNull();
  });
});
