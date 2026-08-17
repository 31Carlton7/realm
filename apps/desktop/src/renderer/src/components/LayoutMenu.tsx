import { PRESETS, type PresetName } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState } from "react";
const LABELS: Record<PresetName, string> = { one: "1-up", "two-col": "2 columns", "three-col": "3 columns", "grid-2x2": "2×2 grid", "grid-3x3": "3×3 grid" };
export function LayoutMenu({ onPick }: { onPick: (p: PresetName) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="layout-menu">
      <button aria-label="Layout presets" title="Layout presets" onClick={() => setOpen((o) => !o)}><Icon name="layout" size={15} /></button>
      {open && <div className="menu">{PRESETS.map((p) => <button key={p} onClick={() => { onPick(p); setOpen(false); }}>{LABELS[p]}</button>)}</div>}
    </div>
  );
}
