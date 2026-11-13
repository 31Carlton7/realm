import { useApp } from "../../state/store";
import type { Block } from "./transcript-model";

type SpaceMadeBlock = Extract<Block, { kind: "space_made" }>;

/**
 * An agent made a space from this chat, as a seam beside the access line: "Made the space Taxes ·
 * Open". Open moves the window there, as a click on the space in the sidebar would; a space deleted
 * since keeps the sentence and loses the button.
 */
export function SpaceMadeLine({ block, enter }: { block: SpaceMadeBlock; enter: boolean }) {
  const selectSpace = useApp((s) => s.selectSpace);
  const run = useApp((s) => s.run);
  const there = useApp((s) => s.spaces.some((sp) => sp.id === block.spaceId));
  return <div className="msg-handoff" data-space-made role="note" data-enter={enter || undefined}>
    <span>{block.note}</span>
    {there && <>
      <span className="msg-handoff-tries" aria-hidden="true">·</span>
      <button type="button" className="msg-handoff-link" title={`Go to ${block.name}`}
        onClick={() => run(() => selectSpace(block.spaceId))}>Open</button>
    </>}
  </div>;
}
