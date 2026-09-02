import { useEffect, useMemo, useRef, useState } from "react";
import type { GuideProgress } from "@realm/contracts";
import { useApp } from "../../state/store";

/**
 * The preview surface for `html` guides and `pdf` files (Plan 22 W1): an iframe onto the server's
 * loopback preview listener.
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
 */
export function PreviewFrame({ documentsId, path, kind, version }: {
  documentsId: string; path: string; kind: "html" | "pdf"; version: string | null;
}) {
  const previewInfo = useApp((s) => s.previewInfo);
  const readGuideProgress = useApp((s) => s.readGuideProgress);
  const recordGuideAttempt = useApp((s) => s.recordGuideAttempt);
  const [info, setInfo] = useState<{ port: number; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    previewInfo().then((i) => { if (!cancelled) setInfo(i); }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [previewInfo]);

  const src = useMemo(() => {
    if (!info) return null;
    const rel = path.split("/").map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${info.port}/p/${info.token}/${documentsId}/${rel}?v=${encodeURIComponent(version ?? "")}`;
  }, [info, documentsId, path, version]);

  useEffect(() => {
    if (kind !== "html") return;
    const send = (progress: GuideProgress) => frame.current?.contentWindow?.postMessage({ type: "realm-guide:progress", progress }, "*");
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { type?: string; topic?: unknown; correct?: unknown; total?: unknown } | null;
      if (!d || typeof d !== "object") return;
      if (d.type === "realm-guide:ready") {
        readGuideProgress(documentsId, path).then(send).catch(() => {});
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
  }, [kind, documentsId, path, readGuideProgress, recordGuideAttempt]);

  if (error) return <div className="documents-error">Preview unavailable: {error}</div>;
  if (!src) return <div className="pane-placeholder muted">Loading preview…</div>;
  return (
    <iframe
      ref={frame}
      className="documents-frame"
      data-kind={kind}
      title={`${kind === "pdf" ? "PDF" : "Guide"} preview of ${path}`}
      src={src}
      // A PDF is rendered by Chromium's own viewer, which does not run inside a sandboxed frame;
      // the file is Realm's own bytes served with a fixed MIME type, so the frame runs unsandboxed.
      {...(kind === "html" ? { sandbox: "allow-scripts allow-forms allow-popups allow-modals" } : {})}
    />
  );
}
