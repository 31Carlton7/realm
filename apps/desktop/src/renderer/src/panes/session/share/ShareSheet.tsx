import { formatAttachmentSize } from "@realm/contracts";
import { useEffect, useMemo, useState } from "react";
import { Sheet } from "../../../components/Sheet";
import { Spinner } from "../../../components/Spinner";
import { useApp } from "../../../state/store";
import { exportFileName } from "../export-session";
import { DEFAULT_SHARE_OPTIONS, type ShareOptions } from "./options";
import type * as Page from "./page";

/** What the sheet has once the session is read: the page's inputs and the builder, which is loaded
 *  with them rather than with the app. */
type Ready = { shared: Page.SharedSession; build: typeof Page.buildSharePage; has: ReturnType<typeof Page.shareContents> };

const ROWS: { key: keyof ShareOptions; name: string; desc: string }[] = [
  { key: "tools", name: "Tool details", desc: "Each command's output, each file it read and each edit's diff, under its line." },
  { key: "thinking", name: "Thinking", desc: "The agent's reasoning, folded under a line of its own." },
  { key: "images", name: "Pictures", desc: "Attached and drawn pictures, inside the file." },
  { key: "subagents", name: "Sub-agents", desc: "What each sub-agent did, under the line that started it." },
  { key: "hidePaths", name: "Hide file paths", desc: "Writes your home folder as ~, so your account name stays out." },
];

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Share as web page: what the page will include, how big it is, and Save.
 *
 * The page is built here, in the window, from a fresh read of the session, and rebuilt as a switch
 * moves — so the size beside Save is the size of the file Save writes. Saving goes through the same
 * native dialog the Markdown export uses; nothing is uploaded or sent. Once saved the foot offers the
 * two things a person does next with a file — find it, or look at it — and a switch moved after that
 * puts Save back, since the file on disk no longer matches what the sheet shows.
 */
export function ShareSheet({ sessionId }: { sessionId: string }) {
  const closeSheet = useApp((s) => s.closeSheet);
  const gatherShare = useApp((s) => s.gatherShare);
  const [ready, setReady] = useState<Ready | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [options, setOptions] = useState<ShareOptions>(DEFAULT_SHARE_OPTIONS);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([gatherShare(sessionId), import("./page")]).then(([shared, page]) => {
      if (!live) return;
      if (!shared) { setFailure("Realm couldn't find this session."); return; }
      setReady({ shared, build: page.buildSharePage, has: page.shareContents(shared) });
    }, (e: unknown) => { if (live) setFailure(`Realm couldn't read the session: ${reason(e)}`); });
    return () => { live = false; };
  }, [sessionId, gatherShare]);

  const page = useMemo(() => (ready ? ready.build(ready.shared, options) : null), [ready, options]);
  const bytes = useMemo(() => (page ? new TextEncoder().encode(page.html).length : 0), [page]);

  const set = (key: keyof ShareOptions, on: boolean) => { setOptions((o) => ({ ...o, [key]: on })); setSaved(null); };
  const save = async () => {
    if (!page || !ready || saving) return;
    setSaving(true); setFailure(null);
    try {
      const path = await window.realm?.saveText?.({ name: exportFileName(page.title, ready.shared.now, "html"), text: page.html });
      if (path) setSaved(path);
    } catch (e) {
      setFailure(`The page wasn't saved: ${reason(e)}`);
    } finally {
      setSaving(false);
    }
  };
  const rows = ready ? ROWS.filter((r) => r.key === "hidePaths" || ready.has[r.key]) : [];
  const name = saved ? saved.slice(saved.lastIndexOf("/") + 1) : "";

  return (
    <Sheet title="Share as web page" onClose={closeSheet} width={480}
      footer={saved ? <>
        <p className="share-sheet-status" title={saved}>Saved {name}</p>
        <button type="button" className="btn" onClick={() => { void window.realm?.files?.reveal?.(saved); }}>Show in Finder</button>
        <button type="button" className="btn" onClick={() => { void window.realm?.openAttachment?.(saved); }}>Open</button>
        <button type="button" className="btn primary" onClick={closeSheet}>Done</button>
      </> : <>
        {page && <p className="share-sheet-status">{formatAttachmentSize(bytes)}</p>}
        <button type="button" className="btn" onClick={closeSheet}>Cancel</button>
        <button type="button" className="btn primary" disabled={!page || saving} aria-busy={saving || undefined} onClick={() => void save()}>
          {saving ? <><Spinner size={14} /> Saving…</> : "Save…"}
        </button>
      </>}>
      <p className="sheet-lede">One HTML file that opens in any browser, with everything it shows inside it. Nothing leaves this Mac until you send it.</p>
      {!ready && !failure && <p className="share-sheet-reading"><Spinner size={14} /> Reading the session…</p>}
      {ready && (
        <div className="settings-group share-sheet-options">
          {rows.map((r) => (
            <label key={r.key} className="settings-row">
              <div className="settings-row-main">
                <span className="settings-row-name">{r.name}</span>
                <span className="settings-row-desc">{r.desc}</span>
              </div>
              <input type="checkbox" role="switch" className="switch" aria-label={r.name}
                checked={options[r.key]} onChange={(e) => set(r.key, e.target.checked)} />
            </label>
          ))}
        </div>
      )}
      {page && page.hidden > 0 && (
        <p className="share-sheet-note">{page.hidden === 1 ? "A value that looks like a key or a token shows" : `${page.hidden} values that look like keys or tokens show`} as [hidden].</p>
      )}
      {page && page.imagesLeftOut > 0 && (
        <p className="share-sheet-note">{page.imagesLeftOut === 1 ? "A picture is" : `${page.imagesLeftOut} pictures are`} too large to include, and {page.imagesLeftOut === 1 ? "is" : "are"} named instead.</p>
      )}
      {failure && <p className="share-sheet-note" role="alert" data-tone="danger">{failure}</p>}
    </Sheet>
  );
}
