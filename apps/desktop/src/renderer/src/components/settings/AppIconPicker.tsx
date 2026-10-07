import { useEffect, useState } from "react";
import graphite from "../../assets/app-icons/default.png?inline";
import indigo from "../../assets/app-icons/indigo.png?inline";
import clay from "../../assets/app-icons/clay.png?inline";
import frost from "../../assets/app-icons/frost.png?inline";
import smoke from "../../assets/app-icons/smoke.png?inline";
import sticker from "../../assets/app-icons/sticker.png?inline";
import ocean from "../../assets/app-icons/ocean.png?inline";
import ember from "../../assets/app-icons/ember.png?inline";
import mint from "../../assets/app-icons/mint.png?inline";

/** Every icon Realm ships, the bundle's own first. Ids are main's (`APP_ICON_IDS`, main/app-icon.ts),
 *  which refuses any other — `app-icon.test.ts` holds the two lists and the asset files together. */
export const APP_ICONS = [
  { id: "default", label: "Graphite", src: graphite },
  { id: "indigo", label: "Indigo", src: indigo },
  { id: "clay", label: "Clay", src: clay },
  { id: "frost", label: "Frost", src: frost },
  { id: "smoke", label: "Smoke", src: smoke },
  { id: "sticker", label: "Sticker", src: sticker },
  { id: "ocean", label: "Ocean", src: ocean },
  { id: "ember", label: "Ember", src: ember },
  { id: "mint", label: "Mint", src: mint },
] as const;

/** The pictures are INLINED (`?inline`, data: URLs) rather than emitted as files, because a file is
 *  something the page would have to fetch to hand main its bytes — and the renderer's CSP allows no
 *  fetch outside 127.0.0.1, so in the built app, which loads from file://, the pick silently did
 *  nothing (app-icon-live.mjs caught it). Nine ~60 KB pictures cost the bundle ~700 KB of base64. */
export function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const bridge = () => window.realm?.appIcon;
export const canChooseAppIcon = (): boolean => typeof bridge()?.set === "function";

/**
 * Settings ▸ App ▸ App icon. A tile per icon; picking one puts it on the Dock at once and keeps it for
 * the next launch. The picture main is handed is the one the tile draws, so what you click is
 * exactly what the Dock shows.
 */
export function AppIconPicker() {
  const [chosen, setChosen] = useState<string>("default");
  useEffect(() => {
    let live = true;
    void bridge()?.get().then((id) => { if (live) setChosen(id); });
    return () => { live = false; };
  }, []);

  const choose = async (id: string, src: string) => {
    const was = chosen;
    setChosen(id);
    try {
      if (!(await bridge()?.set(id, dataUrlBytes(src)))) setChosen(was);
    } catch {
      setChosen(was);
    }
  };

  return (
    <fieldset className="app-icon-grid" aria-label="App icon">
      {APP_ICONS.map((icon) => (
        <label key={icon.id} className="app-icon-opt" data-selected={chosen === icon.id || undefined}>
          <input type="radio" name="settings-app-icon" value={icon.id} checked={chosen === icon.id}
            onChange={() => void choose(icon.id, icon.src)} />
          <img src={icon.src} alt="" width={56} height={56} draggable={false} />
          <span className="app-icon-name">{icon.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
