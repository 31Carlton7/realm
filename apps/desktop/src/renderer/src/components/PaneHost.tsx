import { Fragment, type JSX } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { Item, Layout } from "@realm/contracts";
import type { DropEdge } from "../state/store";
import { PanelBar } from "./PanelBar";
import { PaneFor } from "../panes/registry";

export type PaneHostProps = {
  layout: Layout; items: Item[]; focusedLeafId: string | null;
  onFocus: (leafId: string) => void;
  /** Layout-only close: the item leaves the layout but keeps existing (SPACE group). */
  onClose: (itemId: string) => void;
  onSplit: (leafId: string, dir: "row" | "col") => void;
  onResize?: (splitId: string, sizes: number[]) => void;
  /** Task 7 wires the drop-zone UI; the store's openItemAt is already self-drop-safe. */
  onDropItem?: (itemId: string, leafId: string, edge: DropEdge) => void;
};

export function PaneHost(p: PaneHostProps) {
  const byId = new Map(p.items.map((i) => [i.id, i]));
  return <div className="panehost">{renderNode(p.layout)}</div>;

  function renderNode(n: Layout): JSX.Element {
    if (n.type === "leaf") {
      const item = n.itemId ? byId.get(n.itemId) ?? null : null;
      return (
        <div className="panel" data-leaf-id={n.id} data-focused={n.id === p.focusedLeafId || undefined}
          onPointerDownCapture={() => p.onFocus(n.id)}>
          {item && <PanelBar item={item} onSplit={(dir) => p.onSplit(n.id, dir)} onClose={() => p.onClose(item.id)} />}
          <div className="panel-body">
            {!item && <div className="pane-placeholder muted">Open something from the sidebar.</div>}
            {item && <div className="pane-slot"><PaneFor item={item} visible /></div>}
          </div>
        </div>
      );
    }
    return (
      <PanelGroup id={n.id} direction={n.dir === "row" ? "horizontal" : "vertical"} onLayout={(sizes) => p.onResize?.(n.id, sizes)}>
        {n.children.map((c, i) => (
          <Fragment key={c.id}>
            {i > 0 && <PanelResizeHandle className="resize-handle" />}
            <Panel id={c.id} order={i} defaultSize={n.sizes[i] ?? 100 / n.children.length} minSize={10}>{renderNode(c)}</Panel>
          </Fragment>
        ))}
      </PanelGroup>
    );
  }
}
