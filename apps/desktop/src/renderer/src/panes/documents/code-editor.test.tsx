import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";

/**
 * The grammars are the one thing a jsdom test must not really load: each arm of `loadCodeMode` is a
 * dynamic import of a parse table, and resolving fourteen of them would make this suite a download
 * test. The mock records WHICH grammar was asked for, which is the part this component decides.
 */
const asked: string[] = [];
vi.mock("./code-modes", () => ({
  loadCodeMode: (language: string) => { asked.push(language); return Promise.resolve(null); },
}));

import { CodeEditor } from "./CodeEditor";

/** The live view behind the rendered DOM. Edits are dispatched through it rather than typed, because
 *  jsdom lays nothing out and a `contenteditable` there does not accept synthetic text input. */
function viewOf(container: HTMLElement): EditorView {
  const el = container.querySelector<HTMLElement>(".cm-editor");
  const view = el && EditorView.findFromDOM(el);
  if (!view) throw new Error("no CodeMirror view mounted");
  return view;
}

const docOf = (container: HTMLElement) => viewOf(container).state.doc.toString();

/** A user edit: a real transaction, so it lands on the undo history exactly as typing would. */
function type(container: HTMLElement, at: number, insert: string) {
  const view = viewOf(container);
  act(() => { view.dispatch({ changes: { from: at, insert } }); });
}

beforeEach(() => { asked.length = 0; });

/**
 * CodeMirror resolves `Mod-` against the platform at runtime: Cmd on macOS, Ctrl everywhere else.
 * jsdom reports neither a Mac userAgent nor a Mac platform, so under test `Mod-s` is **Ctrl-s** even
 * though the shipped app — macOS only — always sees Cmd-s. Pressing Ctrl here is therefore testing
 * the same binding the user presses, not a different one; hard-coding `metaKey` would test a chord
 * CodeMirror has not bound in this environment and fail for a reason that says nothing about Realm.
 */
const MOD = { ctrlKey: true } as const;

describe("CodeEditor", () => {
  it("shows the file it was given", () => {
    /* Braces, not quotes: a JSX string attribute is literal, so `text="…\n"` would hand the editor a
       backslash and an n rather than a newline — and the assertion below, a real JS string, would not
       match it. */
    const { container } = render(<CodeEditor path="src/a.ts" text={"const x = 1;\n"} onChange={() => {}} />);
    expect(docOf(container)).toBe("const x = 1;\n");
  });

  it("reports the whole document on an edit, not the change", () => {
    const onChange = vi.fn();
    const { container } = render(<CodeEditor path="src/a.ts" text="const x = 1;" onChange={onChange} />);
    type(container, 12, "\n");
    expect(onChange).toHaveBeenCalledWith("const x = 1;\n");
  });

  it("ignores its own value coming back as a prop", () => {
    // The echo. Without the guard, every keystroke round-trips through the pane's buffer and comes
    // back as a "new" document: the editor replaces itself, the cursor collapses to the start, and
    // typing becomes impossible.
    const onChange = vi.fn();
    const { container, rerender } = render(<CodeEditor path="src/a.ts" text="ab" onChange={onChange} />);
    const view = viewOf(container);
    act(() => { view.dispatch({ changes: { from: 2, insert: "c" }, selection: { anchor: 3 } }); });
    rerender(<CodeEditor path="src/a.ts" text="abc" onChange={onChange} />);
    expect(view.state.selection.main.anchor).toBe(3);
    expect(docOf(container)).toBe("abc");
  });

  it("adopts a change that came from disk", () => {
    const { container, rerender } = render(<CodeEditor path="src/a.ts" text="mine" onChange={() => {}} />);
    rerender(<CodeEditor path="src/a.ts" text="theirs, written by an agent" onChange={() => {}} />);
    expect(docOf(container)).toBe("theirs, written by an agent");
  });

  it("does not let undo reach behind a change that came from disk", () => {
    /* The failure this prevents destroys work: ⌘Z after an outside reload would restore a version of
       the file that no longer exists, and the pane's next autosave would write it back over the
       agent's edit — the lost update `baseHash` exists to stop, reintroduced through the keyboard. */
    const { container, rerender } = render(<CodeEditor path="src/a.ts" text="mine" onChange={() => {}} />);
    rerender(<CodeEditor path="src/a.ts" text="theirs" onChange={() => {}} />);
    const view = viewOf(container);
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("theirs");
  });

  it("undoes and redoes the user's own edits", () => {
    const { container } = render(<CodeEditor path="src/a.ts" text="one" onChange={() => {}} />);
    type(container, 3, " two");
    const view = viewOf(container);
    expect(view.state.doc.toString()).toBe("one two");
    act(() => { undo(view); });
    expect(view.state.doc.toString()).toBe("one");
    act(() => { redo(view); });
    expect(view.state.doc.toString()).toBe("one two");
  });

  it("keeps the selection inside a file that got shorter", () => {
    const { container, rerender } = render(<CodeEditor path="src/a.ts" text="a long line of text" onChange={() => {}} />);
    const view = viewOf(container);
    act(() => { view.dispatch({ selection: { anchor: 18 } }); });
    rerender(<CodeEditor path="src/a.ts" text="short" onChange={() => {}} />);
    expect(view.state.selection.main.anchor).toBeLessThanOrEqual(5);
  });

  it("claims Cmd-S, whether or not anyone is listening", () => {
    const onSave = vi.fn();
    const { container } = render(<CodeEditor path="src/a.ts" text="x" onChange={() => {}} onSave={onSave} />);
    const handled = !fireEvent.keyDown(viewOf(container).contentDOM, { key: "s", ...MOD });
    expect(onSave).toHaveBeenCalledTimes(1);
    // Unclaimed, this is the browser's own save-page dialog inside a packaged app.
    expect(handled).toBe(true);
  });

  it("opens find on Cmd-F", () => {
    const { container } = render(<CodeEditor path="src/a.ts" text="alpha beta" onChange={() => {}} />);
    fireEvent.keyDown(viewOf(container).contentDOM, { key: "f", ...MOD });
    expect(container.querySelector(".cm-panel.cm-search")).not.toBeNull();
  });

  it("asks for the grammar the path names, and re-asks when the path changes", async () => {
    const { rerender } = render(<CodeEditor path="src/a.ts" text="" onChange={() => {}} />);
    await waitFor(() => expect(asked).toEqual(["typescript"]));
    rerender(<CodeEditor path="scripts/build.py" text="" onChange={() => {}} />);
    await waitFor(() => expect(asked).toEqual(["typescript", "python"]));
  });

  it("still edits a file it has no grammar for", async () => {
    const onChange = vi.fn();
    const { container } = render(<CodeEditor path="notes.frobnicate" text="hello" onChange={onChange} />);
    await waitFor(() => expect(asked).toEqual(["text"]));
    type(container, 5, "!");
    expect(onChange).toHaveBeenCalledWith("hello!");
  });

  it("puts the cursor on the line a search sent it to", () => {
    const { container } = render(
      <CodeEditor path="src/a.ts" text={"one\ntwo\nthree\n"} onChange={() => {}} revealLine={3} />);
    const view = viewOf(container);
    expect(view.state.doc.lineAt(view.state.selection.main.anchor).number).toBe(3);
  });

  it("clamps a line the file no longer has rather than failing to open", () => {
    // The file can be edited between the search and the open. The top of the right file beats an
    // exception about the wrong line.
    const { container } = render(
      <CodeEditor path="src/a.ts" text={"one\n"} onChange={() => {}} revealLine={400} />);
    expect(viewOf(container).state.selection.main.anchor).toBeLessThanOrEqual(4);
  });

  it("names the file on the editing surface, where a reader will hear it", async () => {
    const { container } = render(<CodeEditor path="apps/server/src/app.ts" text="" onChange={() => {}} />);
    await waitFor(() => {
      expect(container.querySelector(".cm-content")).toHaveAttribute("aria-label", "Edit app.ts");
    });
  });
});
