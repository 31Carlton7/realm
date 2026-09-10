import { SPACE_ICONS } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../state/store";
import { SpaceIcon } from "./SpaceIcon";
import { Spinner } from "./Spinner";
import { useAnchoredPopover } from "./use-anchored-popover";
import { useFileDrop } from "./use-file-drop";

/** The image types the server accepts as an icon (icons/service.ts's `ALLOWED_UPLOAD_MIMES`), by the
 *  MIME Chromium puts on a dropped File. Anything else is refused here with a sentence rather than
 *  sent to fail. */
const ICON_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

/** The one image in a drop, or the reason there is none. A drop of several files takes the first
 *  image — an icon is one picture, and uploading a folder's worth to pick one is not what a drop
 *  onto a single control means. */
export function droppedIcon(files: File[]): { file: File } | { error: string } {
  const image = files.find((f) => ICON_IMAGE_MIMES.has(f.type));
  if (image) return { file: image };
  return { error: files.length === 1 ? `${files[0]!.name} is not an image Realm can use as an icon.` : "None of those is an image Realm can use as an icon." };
}

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
  const [dropError, setDropError] = useState<string | null>(null);
  const uploadIconFile = useApp((s) => s.uploadIconFile);
  /* An image dropped straight onto the trigger becomes the icon in one move — the picker's
     Uploaded tab is the same upload with a dialog in front of it, and a file already in hand needs
     no dialog. The error lands beside the button, where the drop happened. */
  const drop = useFileDrop((files) => {
    const picked = droppedIcon(files);
    if ("error" in picked) { setDropError(picked.error); return; }
    setDropError(null);
    uploadIconFile(profileId, picked.file).then(
      (asset) => onPick(`asset:${asset.id}`),
      (e: unknown) => setDropError(e instanceof Error ? e.message : "Upload failed."),
    );
  }, true);
  return (
    <>
      <button ref={btn} type="button" className="icon-picker-trigger" aria-haspopup="dialog" aria-expanded={open}
        data-dropping={drop.dropping || undefined} {...drop.handlers}
        onClick={() => setOpen((v) => !v)}>
        <SpaceIcon icon={icon} size={20} />
        <span>{drop.dropping ? "Drop to use as icon" : "Change icon…"}</span>
      </button>
      {dropError && <p className="ip-error" role="alert">{dropError}</p>}
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
  const [uploadError, setUploadError] = useState<string | null>(null);

  const assets = useApp((s) => s.iconAssets[profileId] ?? NO_ASSETS);
  const refreshIconAssets = useApp((s) => s.refreshIconAssets);
  const generateIcon = useApp((s) => s.generateIcon);
  const uploadIconImage = useApp((s) => s.uploadIconImage);
  const uploadIconFile = useApp((s) => s.uploadIconFile);
  /* The whole popover takes a drop, whichever tab is up: a picture dragged in is an upload however
     the picker happened to be left, and switching to the Uploaded tab first is a step nobody should
     have to know about. The tab switches itself so the result lands where the eye is. */
  const drop = useFileDrop((files) => {
    const picked = droppedIcon(files);
    setTab("uploaded");
    if ("error" in picked) { setUploadError(picked.error); return; }
    setUploadError(null); setUploading(true);
    uploadIconFile(profileId, picked.file).then(
      (asset) => { setUploading(false); onPick(`asset:${asset.id}`); },
      (e: unknown) => { setUploading(false); setUploadError(e instanceof Error ? e.message : "Upload failed."); },
    );
  }, true);
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
    setUploading(true); setUploadError(null);
    uploadIconImage(profileId).then(
      (asset) => { setUploading(false); if (asset) onPick(`asset:${asset.id}`); },
      (e: unknown) => { setUploading(false); setUploadError(e instanceof Error ? e.message : "Upload failed."); },
    );
  };

  return createPortal(
    <div ref={ref} className="icon-picker" role="dialog" aria-label="Choose an icon"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top left" }}
      data-closing={closing || undefined} inert={closing} data-dropping={drop.dropping || undefined} {...drop.handlers}>
      {drop.dropping && <div className="ip-drop-hint" aria-hidden="true">Drop to upload</div>}
      <div className="ip-tabs" role="tablist" aria-label="Icon source">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="ip-tab"
            onClick={() => { setTab(t.id); setQuery(""); }}>{t.label}</button>
        ))}
      </div>
      {(tab === "default" || tab === "emoji") && (
        <div className="ip-search">
          <Icon name="search" size={14} />
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
            {generating ? <><Spinner size={14} /> Generating…</> : <><Icon name="sparkles" size={14} /> Generate</>}
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
            <Icon name="attach" size={14} /> {uploading ? "Uploading…" : "Upload image…"}
          </button>
          <p className="ip-hint">Or drop an image anywhere on this panel.</p>
          {uploadError && <p className="ip-error" role="alert">{uploadError}</p>}
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
