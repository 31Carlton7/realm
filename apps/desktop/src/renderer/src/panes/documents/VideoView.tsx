import { basenameOf } from "@realm/contracts";
import { VideoPlayer } from "../../components/video/VideoPlayer";
import { useMediaFile } from "../session/media/use-media";

/**
 * A video opened in the documents pane: Realm's player, given the pane. This is where a video goes
 * when anything in the app opens one — a link in the transcript, the Library, an agent's `docs_open` —
 * rather than to QuickTime. The file is never read as bytes here; main streams it to the element.
 *
 * `version` is the file's hash on disk, which the pane's watcher moves when the file changes — so a
 * render an agent is still writing, which fails to load half-made, is tried again once it moves.
 */
export function VideoView({ path, version }: { path: string; version: string | null }) {
  const file = useMediaFile(path);
  if (file === undefined) return <div className="documents-video" />;
  if (file === null) {
    return (
      <div className="documents-video">
        <p className="pane-empty-line">{basenameOf(path)} is no longer on disk, or Realm cannot read it.</p>
      </div>
    );
  }
  return (
    <div className="documents-video">
      <VideoPlayer file={file} variant="pane" autoFocus version={version} />
    </div>
  );
}
