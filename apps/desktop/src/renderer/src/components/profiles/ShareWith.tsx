import { useRef, useState } from "react";
import { useApp, type ShareResult } from "../../state/store";
import { Menu } from "../Menu";
import { SpaceIcon } from "../SpaceIcon";

/**
 * Share with ▸ <profile> (Plan 27 Phase 2): a saved sign-in or a passkey is a profile's own now, and
 * this is how one gets into another profile. It COPIES — the row it sits on stays exactly where it
 * was, so nothing in the list changes and the receipt beside the button is what says it worked.
 *
 * Drawn only where there is somewhere to share into. With one profile there is no other, and a button
 * whose only menu is empty is a promise with nothing behind it.
 */
export function ShareWith({ fromProfileId, what, share }: {
  fromProfileId: string;
  /** What is being shared, for the menu's accessible name: "the sign-in for https://example.com". */
  what: string;
  share: (toProfileId: string) => Promise<ShareResult>;
}) {
  const profiles = useApp((s) => s.profiles);
  const others = profiles.filter((p) => p.id !== fromProfileId);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  if (others.length === 0) return null;
  const choose = (toProfileId: string) => {
    setNote(null);
    void share(toProfileId).then(
      (r) => setNote(r.ok ? `Shared with ${r.profileName}.` : r.error),
      (e: unknown) => setNote(e instanceof Error ? e.message : "That could not be shared."),
    );
  };
  return (
    <>
      {note !== null && <span className="share-note" role="status">{note}</span>}
      <button ref={anchor} type="button" className="btn-quiet" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(true)}>Share with…</button>
      {open && (
        <Menu anchorRef={anchor} align="right" label={`Share ${what} with`} onClose={() => setOpen(false)}
          items={others.map((p) => ({ label: p.name, icon: <SpaceIcon icon={p.icon} size={14} />, onSelect: () => choose(p.id) }))} />
      )}
    </>
  );
}
