import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { REALM_ITEM_TYPE } from "../../components/drag-types";
import { useItemDrop } from "../../components/use-item-drop";

/* The hook, against a real DragEvent. The pane's own wiring is covered by the store tests; what can
   only be checked here is that the two drag VOCABULARIES stay apart — Realm drags its own sessions
   between groups, and a prompter that claimed those would break moving a session into a group. */

function Harness({ onItem, onOuter }: { onItem: (id: string) => void; onOuter: () => void }) {
  const drop = useItemDrop(onItem);
  return (
    <div data-testid="outer" onDrop={onOuter} onDragOver={onOuter} onDragEnter={onOuter}>
      <div data-testid="inner" {...drop.handlers}>{drop.dropping ? "lit" : "dark"}</div>
    </div>
  );
}

const dt = (types: string[], data: Record<string, string> = {}) => ({
  types, getData: (t: string) => data[t] ?? "", dropEffect: "none", files: [],
});

beforeEach(cleanup);

describe("dropping one of Realm's own items on the prompter", () => {
  it("takes an item drag and reports the id", () => {
    const onItem = vi.fn();
    render(<Harness onItem={onItem} onOuter={() => {}} />);
    const inner = screen.getByTestId("inner");
    fireEvent.drop(inner, { dataTransfer: dt([REALM_ITEM_TYPE], { [REALM_ITEM_TYPE]: "it-7" }) });
    expect(onItem).toHaveBeenCalledWith("it-7");
  });

  it("lights only while the drag is over it, and survives crossing a child", () => {
    // Depth, not a boolean: dragging across a child fires leave-then-enter, and a boolean flickers
    // the target off at every internal boundary.
    render(<Harness onItem={() => {}} onOuter={() => {}} />);
    const inner = screen.getByTestId("inner");
    fireEvent.dragEnter(inner, { dataTransfer: dt([REALM_ITEM_TYPE]) });
    fireEvent.dragEnter(inner, { dataTransfer: dt([REALM_ITEM_TYPE]) });
    fireEvent.dragLeave(inner, { dataTransfer: dt([REALM_ITEM_TYPE]) });
    expect(inner.textContent).toBe("lit");
    fireEvent.dragLeave(inner, { dataTransfer: dt([REALM_ITEM_TYPE]) });
    expect(inner.textContent).toBe("dark");
  });

  it("lets a FILE drag straight through to the file target", () => {
    /* The two vocabularies must not collide: files attach, items point. A hook that claimed
       everything would swallow every file dropped on the prompter. */
    const onItem = vi.fn(), onOuter = vi.fn();
    render(<Harness onItem={onItem} onOuter={onOuter} />);
    fireEvent.drop(screen.getByTestId("inner"), { dataTransfer: dt(["Files"]) });
    expect(onItem).not.toHaveBeenCalled();
    expect(onOuter).toHaveBeenCalled();
  });

  it("claims an item drag so the pane behind it never also acts on it", () => {
    // THE mutant: dropping the stopPropagation. One drop would then both point the draft at the
    // session AND move it between groups.
    const onOuter = vi.fn();
    render(<Harness onItem={() => {}} onOuter={onOuter} />);
    fireEvent.drop(screen.getByTestId("inner"), { dataTransfer: dt([REALM_ITEM_TYPE], { [REALM_ITEM_TYPE]: "it-1" }) });
    expect(onOuter).not.toHaveBeenCalled();
  });

  it("says LINK rather than copy — nothing is duplicated by pointing at a session", () => {
    render(<Harness onItem={() => {}} onOuter={() => {}} />);
    const transfer = dt([REALM_ITEM_TYPE]);
    fireEvent.dragOver(screen.getByTestId("inner"), { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe("link");
  });
});
