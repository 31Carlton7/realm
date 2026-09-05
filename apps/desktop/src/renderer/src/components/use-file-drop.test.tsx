import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { carriesFiles, REALM_ITEM_TYPE } from "./drag-types";
import { useFileDrop } from "./use-file-drop";

const dt = (files: File[] = []) => ({ dataTransfer: { files, items: files.map(() => ({ kind: "file" })), types: ["Files"] } });
const paneDrag = { dataTransfer: { files: [], items: [], types: [REALM_ITEM_TYPE] } };
const file = (name = "a.png") => new File([new Uint8Array(2)], name, { type: "image/png" });

/** The real shape: a claiming target nested inside a plain one, which is the session pane with the
 *  prompter inside it. Everything subtle about the hook is about how those two interact. */
function Nested({ onOuter, onInner }: { onOuter: (f: File[]) => void; onInner: (f: File[]) => void }) {
  const outer = useFileDrop(onOuter);
  const inner = useFileDrop(onInner, true);
  return (
    <div data-testid="outer" data-dropping={outer.dropping || undefined} {...outer.handlers}>
      <div data-testid="sibling" />
      <div data-testid="inner" data-dropping={inner.dropping || undefined} {...inner.handlers}>
        <div data-testid="inner-child" />
      </div>
    </div>
  );
}

const mount = () => {
  const onOuter = vi.fn(), onInner = vi.fn();
  render(<Nested onOuter={onOuter} onInner={onInner} />);
  return { onOuter, onInner, outer: screen.getByTestId("outer"), inner: screen.getByTestId("inner") };
};
const dropping = (el: HTMLElement) => el.hasAttribute("data-dropping");

describe("carriesFiles", () => {
  it("separates a file drag from Realm's own — the two vocabularies never overlap", () => {
    expect(carriesFiles({ dataTransfer: { types: ["Files"] } as unknown as DataTransfer })).toBe(true);
    expect(carriesFiles({ dataTransfer: { types: [REALM_ITEM_TYPE] } as unknown as DataTransfer })).toBe(false);
    expect(carriesFiles({ dataTransfer: { types: [] } as unknown as DataTransfer })).toBe(false);
    expect(carriesFiles({ dataTransfer: null })).toBe(false);
  });
});

describe("useFileDrop", () => {
  it("lights up on a file drag and hands the files over on the drop", () => {
    const { onOuter, outer } = mount();
    fireEvent.dragEnter(outer, dt());
    expect(dropping(outer)).toBe(true);
    const f = file();
    fireEvent.drop(outer, dt([f]));
    expect(onOuter).toHaveBeenCalledWith([f]);
    expect(dropping(outer)).toBe(false);
  });

  it("ignores a Realm pane drag entirely, so it falls through to the pane's own drop handling", () => {
    const { onOuter, outer } = mount();
    fireEvent.dragEnter(outer, paneDrag);
    expect(dropping(outer)).toBe(false);
    // Not preventDefault'ed either: fireEvent returns false only when a handler consumed the event,
    // and a consumed dragover is what would stop PaneHost from ever seeing the drag.
    expect(fireEvent.dragOver(outer, paneDrag)).toBe(true);
    fireEvent.drop(outer, paneDrag);
    expect(onOuter).not.toHaveBeenCalled();
  });

  it("crossing into a child does not flicker the target off", () => {
    const { outer } = mount();
    fireEvent.dragEnter(outer, dt());
    fireEvent.dragEnter(screen.getByTestId("sibling"), dt()); // into a child
    fireEvent.dragLeave(outer, dt());                          // …and out of the parent
    expect(dropping(outer)).toBe(true);
    fireEvent.dragLeave(screen.getByTestId("sibling"), dt());
    expect(dropping(outer)).toBe(false);
  });

  it("a drop is handled once: the inner target claims it and the outer never sees it", () => {
    const { onOuter, onInner, inner } = mount();
    const f = file();
    fireEvent.drop(inner, dt([f]));
    expect(onInner).toHaveBeenCalledWith([f]);
    // The named mutant: drop `e.stopPropagation()` from the hook and the file is attached twice.
    expect(onOuter).not.toHaveBeenCalled();
  });

  it("exactly one of the two is ever lit — the inner one takes the drag off the outer", () => {
    const { outer, inner } = mount();
    fireEvent.dragEnter(outer, dt());
    expect(dropping(outer)).toBe(true);
    // Into the inner target: the browser fires enter on the new target and leave on the old one.
    fireEvent.dragEnter(inner, dt());
    fireEvent.dragLeave(outer, dt());
    expect(dropping(inner)).toBe(true);
    expect(dropping(outer)).toBe(false);
  });

  it("and back out again — the outer target's count survives the round trip", () => {
    const { outer, inner } = mount();
    fireEvent.dragEnter(outer, dt());
    fireEvent.dragEnter(inner, dt());
    fireEvent.dragLeave(outer, dt());
    // Leaving the inner target for the outer one. The mutant: claim on the drop alone. The outer
    // would then have counted this leave without ever counting the matching enter, sit at -1, and
    // never light up again for the rest of the drag.
    fireEvent.dragEnter(outer, dt());
    fireEvent.dragLeave(inner, dt());
    expect(dropping(outer)).toBe(true);
    expect(dropping(inner)).toBe(false);
    fireEvent.dragLeave(outer, dt());
    expect(dropping(outer)).toBe(false);
  });

  it("a drop carrying no files still clears the target rather than leaving it lit", () => {
    const { onOuter, outer } = mount();
    fireEvent.dragEnter(outer, dt());
    fireEvent.drop(outer, dt([]));
    expect(dropping(outer)).toBe(false);
    expect(onOuter).not.toHaveBeenCalled();
  });
});
