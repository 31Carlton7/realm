import { SPACE_COLORS } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useApp } from "../state/store";
import { IconPicker } from "./IconPicker";
import { useSpaceTint } from "./sidebar/use-sidebar-model";
import { useFileDrop } from "./use-file-drop";

/*
 * The fields a space is made from, shared by first run's "Name your space" step and the New space
 * sheet — so the control someone meets on their first launch is the one they meet every time after,
 * and the two cannot drift into two ideas of what a space is.
 */

/** What a new space wears until someone says otherwise. */
export const DEFAULT_SPACE_ICON = "folder";

/**
 * A space's name, with how it will look beside it.
 *
 * The icon is a tile left of the field — the glyph, in the colour, that the sidebar will draw — and
 * the tile is also the control: a click opens the picker (symbols, emoji, generated, uploaded), and
 * an image dropped on it becomes the icon. The swatches sit under both, so the identity reads as one
 * thing and changes as it is chosen. The host focuses `nameRef`: the name is the one field anybody
 * has to type, and a sheet focuses its first control, which is the tile.
 */
export function SpaceIdentityField({ name, onName, placeholder, icon, onIcon, color, onColor, profileId, nameRef, className }: {
  name: string; onName: (name: string) => void; placeholder: string;
  icon: string; onIcon: (icon: string) => void;
  color: string; onColor: (color: string) => void;
  /** Whose icon library the picker offers: the profile the space is being made in. */
  profileId: string;
  nameRef?: Ref<HTMLInputElement>; className?: string;
}) {
  const tint = useSpaceTint(color);
  const id = useId();
  return (
    <div className={className ? `space-identity ${className}` : "space-identity"}>
      <label className="space-identity-label" htmlFor={id}>Name</label>
      <div className="space-identity-row">
        <IconPicker variant="tile" tint={tint} icon={icon} profileId={profileId} onPick={onIcon} />
        <input id={id} ref={nameRef} className="space-name" aria-label="Space name" value={name} placeholder={placeholder}
          spellCheck={false} autoComplete="off" onChange={(e) => onName(e.target.value)} />
      </div>
      <SpaceColorSwatches color={color} onColor={onColor} />
    </div>
  );
}

/** The palette as one radio group: a single stop for Tab, and the arrows move the choice. */
export function SpaceColorSwatches({ color, onColor }: { color: string; onColor: (color: string) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // A colour from outside the palette (typed as hex on the space's page) checks nothing; the first
  // swatch is still where Tab lands.
  const at = Math.max(0, SPACE_COLORS.findIndex((c) => c === color));
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (at + step + SPACE_COLORS.length) % SPACE_COLORS.length;
    onColor(SPACE_COLORS[next]!);
    buttons.current[next]?.focus();
  };
  return (
    <div className="swatches" role="radiogroup" aria-label="Color" onKeyDown={onKeyDown}>
      {SPACE_COLORS.map((c, i) => (
        <button key={c} ref={(el) => { buttons.current[i] = el; }} type="button" role="radio" aria-checked={color === c}
          aria-label={`Color ${c}`} tabIndex={i === at ? 0 : -1} className="swatch" data-selected={color === c || undefined}
          style={{ background: c }} onClick={() => onColor(c)} />
      ))}
    </div>
  );
}

/**
 * The folder a space works in: optional, chosen through the dialog or dropped from the Finder. With
 * none, the field says where the space's sessions WILL run — the folder Realm makes for it, named by
 * the server as the name changes, since the slug and its `-2` are the server's to decide. A space's
 * files landing somewhere nobody was told about is not a surprise a local tool should spring.
 *
 * The whole field takes the drop, and says so only while something is over it.
 */
export function SpaceFolderField({ folder, onFolder, profileId, name, className }: {
  folder: string | null; onFolder: (folder: string | null) => void;
  /** The profile and the name the space will have — between them, the folder Realm would make. */
  profileId: string; name: string; className?: string;
}) {
  const pickFolder = useApp((s) => s.pickFolder);
  const pathForFile = useApp((s) => s.pathForFile);
  const run = useApp((s) => s.run);
  // Chromium hands a dropped directory over as a File with an empty type; the bridge names its path.
  const drop = useFileDrop((files) => {
    const path = files.map((f) => pathForFile(f)).find(Boolean);
    if (path) onFolder(path);
  }, true);
  const choose = () => run(async () => { const p = await pickFolder(); if (p) onFolder(p); });
  const made = useMadeFolder(profileId, folder ? "" : name);
  return (
    <div className={className ? `space-folder ${className}` : "space-folder"} data-dropping={drop.dropping || undefined} {...drop.handlers}>
      <span className="space-folder-label">Folder <span className="space-optional">optional</span></span>
      <div className="space-folder-control">
        {folder ? (
          <>
            <Icon name="folder" size={14} />
            <span className="space-folder-path" title={folder}>{folder}</span>
            <button type="button" className="icon-btn" aria-label="Remove folder" title="Remove folder" onClick={() => onFolder(null)}>
              <Icon name="close" size={12} />
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={choose}>Choose folder…</button>
            <span className="space-folder-note">{drop.dropping ? "Drop to use this folder" : "or drop a repo here"}</span>
          </>
        )}
      </div>
      {!folder && made && (
        <p className="space-folder-default">Without one, sessions run in <span className="space-folder-made" title={made}>{made}</span></p>
      )}
    </div>
  );
}

/** How long typing has to pause before the folder is asked for again — a name is typed a key at a
 *  time, and every key is not a question worth a round trip. */
const ASK_AFTER_MS = 120;

/** The folder `spaces.create` would make for this name, or null until there is a name to make one
 *  from. A failed ask draws nothing rather than a guess. */
function useMadeFolder(profileId: string, name: string): string | null {
  const folderFor = useApp((s) => s.spaceFolderFor);
  const [made, setMade] = useState<string | null>(null);
  const n = name.trim();
  useEffect(() => {
    if (!profileId || !n) { setMade(null); return; }
    let live = true;
    const t = setTimeout(() => {
      folderFor(profileId, n).then((p) => { if (live) setMade(p); }, () => { if (live) setMade(null); });
    }, ASK_AFTER_MS);
    return () => { live = false; clearTimeout(t); };
  }, [profileId, n, folderFor]);
  return made;
}
