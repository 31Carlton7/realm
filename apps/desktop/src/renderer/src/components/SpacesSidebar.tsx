import { Icon } from "@realm/ui";
import { useApp } from "../state/store";
import { useState } from "react";

export function SpacesSidebar() {
  const spaces = useApp((s) => s.spaces);
  const activeSpaceId = useApp((s) => s.activeSpaceId);
  const items = useApp((s) => s.items);
  const layout = useApp((s) => s.layout);
  const selectSpace = useApp((s) => s.selectSpace);
  const createSpace = useApp((s) => s.createSpace);
  const activateTab = useApp((s) => s.activateTab);
  const newTerminal = useApp((s) => s.newTerminal);
  const closeItem = useApp((s) => s.closeItem);
  const [adding, setAdding] = useState(false); const [name, setName] = useState("");
  const activeTabs = new Set(collectActive(layout));
  return (
    <div className="spaces">
      <div className="spaces-header"><span className="label">Spaces</span>
        <button aria-label="New space" title="New space" onClick={() => setAdding(true)}><Icon name="add" size={14} /></button></div>
      {adding && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void createSpace(name.trim()); setName(""); setAdding(false); }}>
          <input autoFocus placeholder="Space name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setAdding(false)} />
        </form>
      )}
      {spaces.map((sp) => (
        <div key={sp.id} className={"space" + (sp.id === activeSpaceId ? " active" : "")}>
          <button className="space-row" onClick={() => void selectSpace(sp.id)}><Icon name={sp.icon} size={14} /><span>{sp.name}</span></button>
          {sp.id === activeSpaceId && (
            <div className="items">
              {items.map((it) => (
                <div key={it.id} className={"item" + (activeTabs.has(it.id) ? " active" : "")}>
                  <button className="item-row" onClick={() => void activateTab(it.id)}><Icon name={it.kind} size={13} /><span>{it.title}</span></button>
                  <button className="item-close" aria-label={`Close ${it.title}`} onClick={() => void closeItem(it.id)}><Icon name="close" size={12} /></button>
                </div>
              ))}
              <button className="item-row add" onClick={() => void newTerminal()}><Icon name="add" size={13} /><span>New terminal</span></button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function collectActive(l: import("@realm/contracts").Layout | null): string[] {
  if (!l) return [];
  return l.type === "leaf" ? (l.activeTab ? [l.activeTab] : []) : l.children.flatMap(collectActive);
}
