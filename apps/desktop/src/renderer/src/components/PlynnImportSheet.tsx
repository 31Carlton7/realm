import { useEffect, useMemo, useState } from "react";
import type { PlynnImportResult, PlynnMeeting } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useApp } from "../state/store";
import { Sheet } from "./Sheet";

const fmtWhen = (iso: string | null): string => {
  if (!iso) return "undated";
  const [d, t] = iso.split("T");
  return t ? `${d} ${t}` : d!;
};
const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Import Plynn recordings into the active space (Plan 22 W4).
 *
 * Reads Plynn's meetings folder on open (a pure read — nothing is created until "Import"), lists
 * newest first with the ones already imported unchecked and marked, and copies the checked ones
 * under `lectures/`. Plynn's files are never touched. When the folder does not exist the sheet
 * says so and where it looked, rather than showing an empty list that reads as a bug.
 */
export function PlynnImportSheet() {
  const closeSheet = useApp((s) => s.closeSheet);
  const plynnList = useApp((s) => s.plynnList);
  const plynnImport = useApp((s) => s.plynnImport);
  const run = useApp((s) => s.run);
  const space = useApp((s) => s.spaces.find((sp) => sp.id === s.activeSpaceId));
  const [state, setState] = useState<{ available: boolean; folder: string; meetings: PlynnMeeting[] } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlynnImportResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void plynnList().then((r) => {
      if (cancelled) return;
      setState(r);
      // Default selection: everything not yet imported. Re-importing is a deliberate click.
      setChecked(new Set(r.meetings.filter((m) => !m.imported).map((m) => m.file)));
    }).catch(() => { if (!cancelled) setState({ available: false, folder: "", meetings: [] }); });
    return () => { cancelled = true; };
  }, [plynnList]);

  const toggle = (file: string) => setChecked((prev) => { const n = new Set(prev); if (n.has(file)) n.delete(file); else n.add(file); return n; });
  const files = useMemo(() => (state?.meetings ?? []).filter((m) => checked.has(m.file)).map((m) => m.file), [state, checked]);

  const submit = () => {
    if (busy || files.length === 0) return;
    setBusy(true);
    run(async () => {
      try { setResult(await plynnImport(files)); } finally { setBusy(false); }
    });
  };

  return (
    <Sheet title="Import from Plynn" onClose={closeSheet} width={560}>
      <div className="form">
        {state === null && <p className="muted">Reading Plynn’s meetings folder…</p>}
        {state !== null && !state.available && (
          <p className="muted">
            No recordings found. Plynn writes one Markdown file per meeting to <code>{state.folder || "its Meetings folder"}</code> when
            a recording stops; record a lecture there first, then import it here.
          </p>
        )}
        {state !== null && state.available && state.meetings.length === 0 && (
          <p className="muted">Plynn’s meetings folder is empty. Record a lecture in Plynn, stop it, and it will show up here.</p>
        )}
        {state !== null && state.meetings.length > 0 && result === null && (
          <>
            <p className="sheet-lede">
              Copies the checked recordings under <code>lectures/</code> in {space ? <strong>{space.name}</strong> : "this space"}, with a
              header naming the source. Plynn’s own files stay where they are.
            </p>
            <ul className="lecture-list" aria-label="Plynn recordings">
              {state.meetings.map((m) => (
                <li key={m.file}>
                  <label className="lecture-row" data-imported={m.imported || undefined}>
                    <input type="checkbox" checked={checked.has(m.file)} onChange={() => toggle(m.file)} aria-label={`Import ${m.title}`} />
                    <Icon name="mic" size={14} />
                    <span className="lecture-title">{m.title}</span>
                    <span className="lecture-meta muted">{fmtWhen(m.startedAt)} · {fmtSize(m.sizeBytes)}{m.imported ? " · imported" : ""}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
        {result !== null && (
          <div className="plynn-result" role="status">
            <p>
              Imported {result.imported.length} {result.imported.length === 1 ? "recording" : "recordings"}
              {result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ""}. The first one is open in the Documents pane.
            </p>
            {result.imported.length > 0 && (
              <ul className="plynn-paths">{result.imported.map((i) => <li key={i.path}><code>{i.path}</code></li>)}</ul>
            )}
            {result.skipped.length > 0 && (
              <ul className="plynn-paths">{result.skipped.map((s) => <li key={s.file}><code>{s.file.split("/").pop()}</code> — {s.reason}</li>)}</ul>
            )}
            <p className="muted">Next: “Wrap up a lecture” from the palette turns the transcript into notes, flashcards and a study guide.</p>
          </div>
        )}
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={closeSheet}>{result ? "Done" : "Cancel"}</button>
          {result === null && state?.available && state.meetings.length > 0 && (
            <button type="button" className="btn primary" disabled={busy || files.length === 0} onClick={submit}>
              {busy ? "Importing…" : files.length === 1 ? "Import 1 recording" : `Import ${files.length} recordings`}
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
