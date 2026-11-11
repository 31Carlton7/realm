import { useState } from "react";
import type { TeammatePermissionMode } from "@realm/contracts";
import { useApp } from "../../state/store";
import type { Block } from "./transcript-model";

type AccessBlock = Extract<Block, { kind: "access_changed" }>;

/**
 * A teammate's access changed from inside a chat, as a seam: "@captain set @polish to Full access, at
 * your request." The Lead's line offers Undo while it is the newest for that teammate, and says why
 * when the server will not undo it. `data-no-agent`: only the person can press it, as Team access.
 */
export function AccessLine({ block, enter }: { block: AccessBlock; enter: boolean }) {
  const undo = useApp((s) => s.undoTeammateAccess);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const offered = block.by !== null && block.latest;
  const press = async () => {
    setBusy(true);
    setRefused(null);
    try {
      await undo(block.teammateId, block.from as TeammatePermissionMode, block.to as TeammatePermissionMode);
    } catch (e) {
      setRefused(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return <div className="msg-handoff" data-access role="note" data-enter={enter || undefined}>
    <span>{block.note}</span>
    {offered && <>
      <span className="msg-handoff-tries" aria-hidden="true">·</span>
      <button type="button" className="msg-handoff-link" data-no-agent="teammate access undo" disabled={busy}
        title={`Put @${block.handle} back the way it was`} onClick={() => void press()}>Undo</button>
    </>}
    {refused && <span className="msg-handoff-tries">{refused}</span>}
  </div>;
}
