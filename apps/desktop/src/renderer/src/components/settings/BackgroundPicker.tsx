import { useEffect, useState, type DragEvent } from "react";
import { DEFAULT_BACKGROUND, MINE_PREFIX, type BackgroundEffect, type BackgroundImage, type BackgroundsAdded } from "@realm/contracts";
import { Icon, type Mode } from "@realm/ui";
import { EmptyState } from "../EmptyState";
import { useApp } from "../../state/store";
import { GALLERY, prefCanMove } from "../../panes/session/backdrop-gallery";
import {
  addYourBackgrounds, pickYourBackgrounds, removeYourBackground, updateYourBackground, useYourBackgrounds, yourBackgroundUrl,
} from "../../state/your-backgrounds";

const TREATMENTS: { effect: BackgroundEffect; label: string }[] = [
  { effect: "dither-color", label: "Colour" },
  { effect: "dither", label: "Two-tone" },
  { effect: "halftone", label: "Halftone" },
];

function Tile({ value, chosen, name, title, onPick, children }: {
  value: string; chosen: boolean; name: string; title?: string; onPick: (v: string) => void; children: React.ReactNode;
}) {
  return (
    <label className="backdrop-opt" data-selected={chosen || undefined} title={title}>
      <input type="radio" name="settings-background" value={value} checked={chosen} onChange={() => onPick(value)} />
      <span className="backdrop-thumb">{children}</span>
      <span className="backdrop-name">{name}</span>
    </label>
  );
}

function MineThumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void yourBackgroundUrl(id, "thumb").then((u) => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [id]);
  return url ? <img src={url} alt="" draggable={false} /> : null;
}

/**
 * Settings ▸ Appearance ▸ Background. Off, Shuffle and every look Realm ships, then the person's own
 * pictures, each a tile; picking one is what the next empty session shows (and the one on screen).
 * Pictures are added by dropping them on the picker or through Choose…, which is the system's
 * dialog; main keeps a copy and reads nothing else.
 */
export function BackgroundPicker({ mode }: { mode: Mode }) {
  const pref = useApp((s) => s.background);
  const setBackground = useApp((s) => s.setBackground);
  const motion = useApp((s) => s.backgroundMotion);
  const setBackgroundMotion = useApp((s) => s.setBackgroundMotion);
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const pathForFile = useApp((s) => s.pathForFile);
  const mine = useYourBackgrounds() ?? [];
  const [dropping, setDropping] = useState(false);
  const pick = (v: string) => run(() => setBackground(v));
  const chosenMine = pref.startsWith(MINE_PREFIX) ? mine.find((m) => `${MINE_PREFIX}${m.id}` === pref) ?? null : null;

  const added = (r: BackgroundsAdded) => {
    const last = r.added.at(-1);
    if (last) pick(`${MINE_PREFIX}${last.id}`);
    for (const f of r.refused) toast({ tone: "warning", text: `Couldn't add ${f.name}. ${f.reason}` });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const paths = Array.from(e.dataTransfer.files).map((f) => pathForFile(f)).filter(Boolean);
    if (paths.length) run(async () => added(await addYourBackgrounds(paths)));
  };
  const choose = () => run(async () => added(await pickYourBackgrounds()));
  const canMove = prefCanMove(pref);

  return (
    <>
      <div className="settings-row" data-stack data-setting="background">
        <div className="settings-row-main"><span className="settings-row-name">New sessions</span></div>
        <fieldset className="backdrop-grid" aria-label="Background">
          <Tile value="off" chosen={pref === "off"} name="Off" onPick={pick}>{null}</Tile>
          <Tile value="shuffle" chosen={pref === "shuffle"} name="Shuffle" title="A different one for each new session, kept for that session." onPick={pick}>
            <span className="backdrop-mosaic">
              {GALLERY.slice(0, 4).map((g) => <img key={g.id} src={mode === "dark" ? g.dark : g.light} alt="" draggable={false} />)}
            </span>
          </Tile>
          {GALLERY.map((g) => (
            <Tile key={g.id} value={g.id} chosen={pref === g.id} name={g.name} title={g.mood || undefined} onPick={pick}>
              <img src={mode === "dark" ? g.dark : g.light} alt="" draggable={false} />
            </Tile>
          ))}
        </fieldset>
      </div>

      <div className="settings-row" data-stack data-setting="background-images">
        <div className="settings-row-main"><span className="settings-row-name">Your images</span></div>
        <div className="backdrop-drop" data-dropping={dropping || undefined}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDropping(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
          onDrop={onDrop}>
          {mine.length === 0 ? (
            <EmptyState icon="image" heading="h2" title="No images yet"
              actions={<button type="button" className="btn" onClick={choose}>Add image…</button>}>
              Drop pictures here. Each is drawn in your theme's colours unless you show it as it is.
            </EmptyState>
          ) : (
            <fieldset className="backdrop-grid" aria-label="Your images">
              {mine.map((m) => (
                <Tile key={m.id} value={`${MINE_PREFIX}${m.id}`} chosen={pref === `${MINE_PREFIX}${m.id}`} name={m.name} onPick={pick}>
                  <MineThumb id={m.id} />
                </Tile>
              ))}
              <button type="button" className="backdrop-opt backdrop-add" onClick={choose}>
                <span className="backdrop-thumb"><Icon name="add" size={16} /></span>
                <span className="backdrop-name">Add image…</span>
              </button>
            </fieldset>
          )}
        </div>
      </div>

      {chosenMine && <YourImageRows key={chosenMine.id} image={chosenMine} onRemoved={() => pick(DEFAULT_BACKGROUND)} />}

      <div className="settings-row" data-setting="background-motion">
        <div className="settings-row-main"><span className="settings-row-name">Motion</span></div>
        <input type="checkbox" role="switch" className="switch" aria-label="Background motion"
          title={canMove ? "Lets the picture drift slowly. It holds still under Reduce motion and Low power, and while the window is idle or in the background." : "This background has no motion."}
          checked={motion && canMove} disabled={!canMove} onChange={(e) => run(() => setBackgroundMotion(e.target.checked))} />
      </div>
    </>
  );
}

/** The picked picture's own rows: its name, how it is printed, and Remove. */
function YourImageRows({ image, onRemoved }: { image: BackgroundImage; onRemoved: () => void }) {
  const run = useApp((s) => s.run);
  const [name, setName] = useState(image.name);
  const rename = () => { if (name.trim() && name.trim() !== image.name) run(() => updateYourBackground(image.id, { name })); else setName(image.name); };
  return (
    <>
      <div className="settings-row" data-setting="background-name">
        <div className="settings-row-main"><span className="settings-row-name">Name</span></div>
        <input className="settings-text" type="text" aria-label="Image name" value={name} maxLength={60}
          onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
      </div>
      <div className="settings-row" data-setting="background-as-is">
        <div className="settings-row-main"><span className="settings-row-name">Show the picture as it is</span></div>
        <input type="checkbox" role="switch" className="switch" aria-label="Show the picture as it is"
          title="Its own pixels, with no dither. It still softens under the greeting until the words read, and around the prompter."
          checked={image.asIs} onChange={(e) => run(() => updateYourBackground(image.id, { asIs: e.target.checked }))} />
      </div>
      {!image.asIs && (
        <div className="settings-row" data-setting="background-treatment">
          <div className="settings-row-main"><span className="settings-row-name">Print</span></div>
          <fieldset className="settings-tabs" aria-label="Print">
            {TREATMENTS.map((t) => (
              <label key={t.effect} className="settings-tab" data-selected={image.effect === t.effect || undefined}>
                <input type="radio" name="settings-background-print" value={t.effect} checked={image.effect === t.effect}
                  onChange={() => run(() => updateYourBackground(image.id, { effect: t.effect }))} />
                {t.label}
              </label>
            ))}
          </fieldset>
        </div>
      )}
      <div className="settings-row" data-setting="background-remove">
        <div className="settings-row-main"><span className="settings-row-name">Remove {image.name}</span></div>
        <button type="button" className="btn-quiet danger" title="Deletes Realm's copy. The file you added it from is left where it was."
          onClick={() => run(async () => { await removeYourBackground(image.id); onRemoved(); })}>Remove</button>
      </div>
    </>
  );
}
