import { Icon } from "@realm/ui";
import type { Item } from "@realm/contracts";

export function TabBar({ tabs, activeTab, onActivate, onClose, onSplit }: {
  tabs: Item[]; activeTab: string | null;
  onActivate: (id: string) => void; onClose: (id: string) => void; onSplit: (dir: "row" | "col") => void;
}) {
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === activeTab} aria-label={t.title}
          className={"tab" + (t.id === activeTab ? " active" : "")} onClick={() => onActivate(t.id)}>
          <Icon name={t.kind} size={13} /><span className="tab-title">{t.title}</span>
          <button className="tab-close" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); onClose(t.id); }}><Icon name="close" size={11} /></button>
        </div>
      ))}
      <div className="tab-actions">
        <button title="Split right (new terminal)" aria-label="Split right" onClick={() => onSplit("row")}>⫽</button>
        <button title="Split down (new terminal)" aria-label="Split down" onClick={() => onSplit("col")}>⩶</button>
      </div>
    </div>
  );
}
