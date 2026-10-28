import { useEffect, useMemo, useRef, useState } from "react";
import type { GuideProgress } from "@realm/contracts";
import { useApp } from "../../state/store";
import { recallScroll, rememberScroll } from "../scroll-memory";
import {
  guideEnvelope, guideStateFrom, guideStateKey, notePersisted, persistStorage, recallGuideState, rememberGuideState,
} from "./guide-state";

/**
 * The preview surface for `html` guides (Plan 22 W1): an iframe onto the server's loopback preview
 * listener. (A PDF used to be framed here too, in Chromium's own viewer; Realm draws it now — PdfView.tsx.)
 *
 * Why a frame onto a real origin, and not `srcdoc`: a `srcdoc`/`blob:`/`data:` document INHERITS the
 * renderer's CSP (`script-src 'self'`), which forbids the inline script every self-contained guide
 * is made of. The preview server hands each guide its own policy (see `preview.ts`), and the
 * `sandbox` attribute here — without `allow-same-origin` — makes the guide's origin opaque: it can
 * run, and it can talk to this pane by postMessage, and that is all.
 *
 * The bridge: the guide runtime posts `realm-guide:ready` on load and `realm-guide:attempt` after
 * "Check answers"; the pane answers both with `realm-guide:progress` carrying the sidecar's history,
 * recording the attempt first. Messages are accepted only from THIS frame's window — a message
 * from any other frame (another guide, a browser pane's page) is ignored.
 *
 * `version` changes force a reload: the parent passes the buffer's disk hash, so an agent's rewrite
 * (delivered through `documents.fileChanged`) re-renders the guide without any polling.
 *
 * What the reader was in the middle of comes back with the frame (`guide-state.ts`). The runtime posts
 * `realm-guide:state` as the reader works and the pane keeps it; the frame is then made with it as its
 * `name`, which the runtime's boot reads before the guide's own scripts run — the only hand-off early
 * enough for a guide that reads its storage as it starts. Its `ready` says whether it found it there;
 * when it did not (it navigated away and back, say), the pane sends its copy once as
 * `realm-guide:restore`. A guide this run has not shown yet is seeded from its sidecar, where its
 * `localStorage` is kept between runs.
 */
export function PreviewFrame({ documentsId, path, version, scrollKey }: {
  documentsId: string; path: string; version: string | null;
  /** Only a guide can honour this — see the scroll branch below, and `guide-runtime.ts`. */
  scrollKey?: string | null;
}) {
  const previewInfo = useApp((s) => s.previewInfo);
  const readGuideProgress = useApp((s) => s.readGuideProgress);
  const recordGuideAttempt = useApp((s) => s.recordGuideAttempt);
  const writeGuideStorage = useApp((s) => s.writeGuideStorage);
  /** Where the frame points, and the name it is MADE with. The name is read once, when the frame is
   *  created: a name set on a frame later renames its window and would overwrite what the runtime has
   *  kept there since. */
  const [info, setInfo] = useState<{ port: number; token: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const key = guideStateKey(documentsId, path);
  /** What the runtime finds in its own URL: the workspace, then the path. */
  const doc = `${documentsId}/${path}`;
  /** The pane's copy is sent back at most once per frame: a guide that keeps losing its name would
   *  otherwise be reloaded with it again and again. */
  const handedBack = useRef(false);

  useEffect(() => {
    let cancelled = false;
    // Its storage from an earlier run, read before the frame exists — afterwards is too late for a
    // guide that reads it as it starts. Only for a guide this run has not shown: a copy held here is
    // newer than the sidecar.
    const kept = recallGuideState(key)
      ? Promise.resolve(null)
      : readGuideProgress(documentsId, path).then((p) => p.storage ?? null, () => null);
    Promise.all([previewInfo(), kept]).then(([i, storage]) => {
      if (cancelled) return;
      if (storage && !recallGuideState(key)) {
        notePersisted(key, storage);
        if (Object.keys(storage).length) rememberGuideState(key, { v: 1, local: storage });
      }
      const top = scrollKey ? recallScroll(scrollKey)?.top ?? null : null;
      setInfo({ ...i, name: guideEnvelope(doc, recallGuideState(key), top) });
    }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [previewInfo, readGuideProgress, documentsId, path, key, doc, scrollKey]);

  const src = useMemo(() => {
    if (!info) return null;
    const rel = path.split("/").map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${info.port}/p/${info.token}/${documentsId}/${rel}?v=${encodeURIComponent(version ?? "")}`;
  }, [info, documentsId, path, version]);

  useEffect(() => {
    // The frame is told its progress and nothing of what the sidecar keeps for it besides.
    const send = ({ storage: _kept, ...progress }: GuideProgress) =>
      frame.current?.contentWindow?.postMessage({ type: "realm-guide:progress", progress }, "*");
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { type?: string; topic?: unknown; correct?: unknown; total?: unknown; doc?: unknown; seeded?: unknown; state?: unknown } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "realm-guide:ready") {
        readGuideProgress(documentsId, path).then(send).catch(() => {});
        // A page the frame was navigated to from a link is not this tab's guide.
        if (d.doc !== undefined && d.doc !== doc) return;
        // It started from what it was handed, scroll and all; there is nothing to send.
        if (d.seeded === true) { handedBack.current = false; return; }
        // The frame is cross-origin, so the offset cannot be read off it — the runtime reports it
        // and is told it back. `atEnd` is meaningless for a guide, which does not grow.
        const mark = scrollKey ? recallScroll(scrollKey) : null;
        if (mark && mark.top > 0) frame.current?.contentWindow?.postMessage({ type: "realm-guide:scroll", top: mark.top }, "*");
        const held = recallGuideState(key);
        if (held && !handedBack.current) {
          handedBack.current = true;
          frame.current?.contentWindow?.postMessage({ type: "realm-guide:restore", state: held }, "*");
        }
      } else if (d.type === "realm-guide:state") {
        if (d.doc !== doc) return;
        const state = guideStateFrom(d.state);
        if (!state) return;
        rememberGuideState(key, state);
        if (state.local) persistStorage(key, state.local, (storage) => writeGuideStorage(documentsId, path, storage));
      } else if (d.type === "realm-guide:scroll") {
        if (scrollKey && typeof (d as { top?: unknown }).top === "number") {
          rememberScroll(scrollKey, { top: (d as { top: number }).top, atEnd: false });
        }
      } else if (d.type === "realm-guide:attempt") {
        const topic = typeof d.topic === "string" ? d.topic.trim() : "";
        const correct = typeof d.correct === "number" ? Math.max(0, Math.floor(d.correct)) : NaN;
        const total = typeof d.total === "number" ? Math.floor(d.total) : NaN;
        if (!topic || !Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return;
        recordGuideAttempt(documentsId, path, topic, Math.min(correct, total), total).then(send).catch(() => {});
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [documentsId, path, doc, key, scrollKey, readGuideProgress, recordGuideAttempt, writeGuideStorage]);

  if (error) return <div className="documents-error">Preview unavailable: {error}</div>;
  if (!src) return <div className="pane-placeholder muted">Loading preview…</div>;
  return (
    <iframe
      ref={frame}
      className="documents-frame"
      title={`Guide preview of ${path}`}
      name={info?.name}
      src={src}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
    />
  );
}
