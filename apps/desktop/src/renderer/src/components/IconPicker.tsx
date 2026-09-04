import { SPACE_ICONS } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../state/store";
import { SpaceIcon } from "./SpaceIcon";
import { Spinner } from "./Spinner";
import { useAnchoredPopover } from "./use-anchored-popover";

/* The emoji tab carries a 387KB dataset it walks at module scope, so it is a chunk of its own and
   arrives when the tab is first opened — not during startup, on behalf of a tab nobody asked for. */
const IconPickerEmoji = lazy(() => import("./IconPickerEmoji"));

// A stable empty-array fallback: `s.iconAssets[profileId] ?? []` would hand useSyncExternalStore a
// freshly allocated array on every render when the profile has no fetched library yet, which reads
// as "the snapshot changed" forever — an infinite render loop, not just a wasted render.
const NO_ASSETS: never[] = [];

type Tab = "default" | "emoji" | "generated" | "uploaded";
const TABS: { id: Tab; label: string }[] = [
  { id: "default", label: "Default" }, { id: "emoji", label: "Emoji" },
  { id: "generated", label: "Generated" }, { id: "uploaded", label: "Uploaded" },
];

/**
 * The space icon picker: a trigger button (current icon + "Change icon") that opens a popover with
 * four sources, replacing the old bare `.icon-grid` fieldset (`SpacePage.tsx`'s `GeneralTab`).
 * Generated/uploaded icons are a per-PROFILE library (`iconAssets.*`) — reusable by every space
 * under that profile, not thrown away after this one pick.
 */
export function IconPicker({ icon, profileId, onPick }: { icon: string; profileId: string; onPick: (icon: string) => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={btn} type="button" className="icon-picker-trigger" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <SpaceIcon icon={icon} size={20} />
        <span>Change icon…</span>
      </button>
      {open && <IconPickerPopover icon={icon} profileId={profileId} anchorRef={btn} onClose={() => setOpen(false)}
        onPick={(v) => { onPick(v); setOpen(false); }} />}
    </>
  );
}

function IconPickerPopover({ icon, profileId, anchorRef, onClose, onPick }: {
  icon: string; profileId: string; anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void; onPick: (icon: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, onClose, exit: true });
  const [tab, setTab] = useState<Tab>("default");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const assets = useApp((s) => s.iconAssets[profileId] ?? NO_ASSETS);
  const refreshIconAssets = useApp((s) => s.refreshIconAssets);
  const generateIcon = useApp((s) => s.generateIcon);
  const uploadIconImage = useApp((s) => s.uploadIconImage);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshIconAssets(profileId)); }, [profileId, refreshIconAssets, run]);

  const q = query.trim().toLowerCase();
  const defaultIcons = useMemo(() => (q ? SPACE_ICONS.filter((n) => n.toLowerCase().includes(q)) : SPACE_ICONS), [q]);
  const generated = assets.filter((a) => a.kind === "generated");
  const uploaded = assets.filter((a) => a.kind === "image");

  const submitGenerate = () => {
    const p = prompt.trim(); if (!p || generating) return;
    setGenerating(true); setGenError(null);
    generateIcon(profileId, p).then(
      (asset) => { setGenerating(false); setPrompt(""); onPick(`asset:${asset.id}`); },
      (e: unknown) => { setGenerating(false); setGenError(e instanceof Error ? e.message : "Icon generation failed."); },
    );
  };
  const doUpload = () => {
    if (uploading) return;
    setUploading(true);
    uploadIconImage(profileId).then(
      (asset) => { setUploading(false); if (asset) onPick(`asset:${asset.id}`); },
      () => { setUploading(false); },
    );
  };

  return createPortal(
    <div ref={ref} className="icon-picker" role="dialog" aria-label="Choose an icon"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top left" }}
      data-closing={closing || undefined} inert={closing}>
      <div className="ip-tabs" role="tablist" aria-label="Icon source">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="ip-tab"
            onClick={() => { setTab(t.id); setQuery(""); }}>{t.label}</button>
        ))}
      </div>
      {(tab === "default" || tab === "emoji") && (
        <div className="ip-search">
          <Icon name="search" size={13} />
          <input autoFocus type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={tab === "default" ? "Search icons…" : "Search emoji…"} aria-label="Search" />
        </div>
      )}
      {tab === "default" && (
        <div className="ip-grid" role="radiogroup" aria-label="Default icons">
          {defaultIcons.map((n) => (
            <button key={n} type="button" role="radio" aria-checked={icon === n} aria-label={`Icon ${n}`} className="icon-choice"
              data-selected={icon === n || undefined} onClick={() => onPick(n)}><Icon name={n} size={18} /></button>
          ))}
          {defaultIcons.length === 0 && <p className="ip-empty">No icons match “{query.trim()}”.</p>}
        </div>
      )}
      {tab === "emoji" && (
        // The chunk is local, so the fallback is a frame or two — a spinner would flash rather than inform.
        <Suspense fallback={<div className="ip-grid" aria-busy="true" />}>
          <IconPickerEmoji icon={icon} query={query} onPick={onPick} />
        </Suspense>
      )}
      {tab === "generated" && (
        <div className="ip-generate">
          <textarea className="ip-generate-prompt" placeholder="Describe the icon you want — e.g. “a friendly orange fox”"
            value={prompt} onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitGenerate(); } }} />
          {/* aria-busy separates the two reasons this is disabled — nothing typed yet vs. a
              generation in flight — for the reader and for the stylesheet, which must not grey the
              button out from under the press that started the work. */}
          <button type="button" className="btn primary" aria-busy={generating} disabled={!prompt.trim() || generating} onClick={submitGenerate}>
            {generating ? <><Spinner size={14} /> Generating…</> : <><Icon name="sparkles" size={13} /> Generate</>}
          </button>
          {genError && <p className="ip-error">{genError}</p>}
          <div className="ip-grid">
            {generated.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={icon === `asset:${a.id}`} aria-label={a.prompt ?? "Generated icon"}
                title={a.prompt ?? undefined} className="icon-choice" data-selected={icon === `asset:${a.id}` || undefined}
                onClick={() => onPick(`asset:${a.id}`)}><SpaceIcon icon={`asset:${a.id}`} size={20} /></button>
            ))}
            {generated.length === 0 && !generating && <p className="ip-empty">Nothing generated yet in this profile.</p>}
          </div>
        </div>
      )}
      {tab === "uploaded" && (
        <div className="ip-generate">
          <button type="button" className="btn" aria-busy={uploading} disabled={uploading} onClick={doUpload}>
            <Icon name="attach" size={13} /> {uploading ? "Uploading…" : "Upload image…"}
          </button>
          <div className="ip-grid">
            {uploaded.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={icon === `asset:${a.id}`} aria-label="Uploaded icon"
                className="icon-choice" data-selected={icon === `asset:${a.id}` || undefined}
                onClick={() => onPick(`asset:${a.id}`)}><SpaceIcon icon={`asset:${a.id}`} size={20} /></button>
            ))}
            {uploaded.length === 0 && <p className="ip-empty">No uploaded icons yet in this profile.</p>}
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
