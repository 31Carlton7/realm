import { Icon } from "@realm/ui";
import type { Item } from "@realm/contracts";
import { paneMeta } from "../panes/registry";

/** Slim per-panel header: item icon + title, per-kind meta (right), split + close actions. */
export function PanelBar({ item, onSplit, onClose }: {
  item: Item; onSplit: (dir: "row" | "col") => void; onClose: () => void;
}) {
  const Meta = paneMeta[item.kind];
  return (
    <div className="panel-bar">
      <span className="panel-icon"><Icon name={item.kind} size={14} /></span>
      <span className="panel-title">{item.title}</span>
      <span className="panel-meta">{Meta ? <Meta item={item} /> : null}</span>
      <span className="panel-actions">
        <button className="icon-btn" aria-label="Split right" title="Split right (⌘\)" onClick={() => onSplit("row")}><Icon name="layout" size={13} /></button>
        <button className="icon-btn" aria-label={`Close ${item.title}`} title="Close" onClick={onClose}><Icon name="close" size={13} /></button>
      </span>
    </div>
  );
}
