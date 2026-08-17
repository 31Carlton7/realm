import { PRESETS, type PresetName } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useRef, useState } from "react";
import { Menu } from "./Menu";

const LABELS: Record<PresetName, string> = { one: "1-up", "two-col": "2 columns", "three-col": "3 columns", "grid-2x2": "2×2 grid", "grid-3x3": "3×3 grid" };

export function LayoutMenu({ onPick }: { onPick: (p: PresetName) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="layout-menu">
      <button ref={btnRef} aria-label="Layout presets" title="Layout presets" onClick={() => setOpen((o) => !o)}><Icon name="layout" size={15} /></button>
      {open && (
        <Menu label="Layout presets" align="right" anchorRef={btnRef} onClose={close}
          items={PRESETS.map((p) => ({ label: LABELS[p], onSelect: () => onPick(p) }))} />
      )}
    </div>
  );
}
