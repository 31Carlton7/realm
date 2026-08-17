import { Fragment, type JSX } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { Item, Layout } from "@realm/contracts";
import { TabBar } from "./TabBar";
import { PaneFor } from "../panes/registry";

export type PaneHostProps = {
  layout: Layout; items: Item[];
  onActivate: (itemId: string) => void; onClose: (itemId: string) => void;
  onSplit: (leafId: string, dir: "row" | "col") => void;
  onResize?: (splitId: string, sizes: number[]) => void;
};

export function PaneHost(p: PaneHostProps) {
  const byId = new Map(p.items.map((i) => [i.id, i]));
  return <div className="panehost">{renderNode(p.layout)}</div>;

  function renderNode(n: Layout): JSX.Element {
    if (n.type === "leaf") {
      const tabs = n.tabs.map((t) => byId.get(t)).filter((x): x is Item => !!x);
      const active = tabs.find((t) => t.id === n.activeTab) ?? tabs[0] ?? null;
      return (
        <div className="leaf" data-leaf-id={n.id}>
          <TabBar tabs={tabs} activeTab={active?.id ?? null} onActivate={p.onActivate} onClose={p.onClose} onSplit={(dir) => p.onSplit(n.id, dir)} />
          <div className="leaf-body">
            {tabs.length === 0 && <div className="pane-placeholder muted">Nothing open — add a terminal from the sidebar or split.</div>}
            {tabs.map((t) => (
              <div key={t.id} className="pane-slot" style={{ display: t.id === active?.id ? "flex" : "none" }}>
                <PaneFor item={t} visible={t.id === active?.id} />
              </div>
            ))}
          </div>
        </div>
      );
    }
    return (
      <PanelGroup direction={n.dir === "row" ? "horizontal" : "vertical"} onLayout={(sizes) => p.onResize?.(n.id, sizes)}>
        {n.children.map((c, i) => (
          <Fragment key={c.id}>
            {i > 0 && <PanelResizeHandle className="resize-handle" />}
            <Panel defaultSize={n.sizes[i] ?? 100 / n.children.length} minSize={10}>{renderNode(c)}</Panel>
          </Fragment>
        ))}
      </PanelGroup>
    );
  }
}
