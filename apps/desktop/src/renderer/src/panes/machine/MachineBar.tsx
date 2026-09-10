import type { Item } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";
import { rpc } from "../../rpc/client";
import { MACHINE_WORDS, machineMeta } from "./MachinePane";

/**
 * The machine pane's own bar content (Plan 25 W3).
 *
 * `PanelBar` is the ONLY bar this pane has, and that is the point. `.browser-chrome` exists because
 * a native view forbade dropdowns and forced an address bar's controls inline; a machine has no
 * address bar, so design.md's "pane bars stay compact and consistent across pane kinds" is finally
 * achievable here.
 *
 * `PanelBar.tsx` itself needs no edit, and that is the tell that the kind is modelled right:
 * `machine` joins neither `PAGE_KINDS` (it has a real row, not a sentinel) nor `DELETES_ON_CLOSE`.
 * A disk image, a saved password and a network address outlive the pane more emphatically than
 * anything in that set, so the × is a plain layout-only close and deleting the machine is the ⋯
 * menu's Delete — which `confirmFirst = !PAGE_KINDS.has(kind)` already arms for free.
 */

/** The state word plus, once there is a screen, the guest's live resolution in mono. */
export function MachineMeta({ item }: { item: Item }) {
  const state = useApp((s) => s.machineState[item.refId]);
  const size = machineMeta(state);
  return (
    <span className="machine-bar-meta">
      <span className="status-dot" data-status={dotFor(state?.status ?? "off")} aria-hidden="true" />
      <span>{MACHINE_WORDS[state?.status ?? "off"]}</span>
      {size && <span className="machine-bar-size">{size}</span>}
    </span>
  );
}

/**
 * The sidebar and pane bar's dot value for a machine's status.
 *
 * Reuses the existing vocabulary where the semantics match and adds only where they differ. This is
 * design.md's "readable without color alone" doing real work: `off` and `suspended` are the one pair
 * with no hue available to separate them, so `suspended` is the app's one RING rather than a disc.
 */
export function dotFor(status: string): string {
  switch (status) {
    case "running": return "running";
    case "failed": return "error";
    // Joins the in-flight ping family rather than borrowing `driving`, whose CSS comment says it
    // means an agent act is in flight — which is a different fact about a different actor.
    case "booting": return "machine-booting";
    case "suspended": return "machine-suspended";
    // Declared rather than defaulted, so a typo in a status cannot silently render as "off".
    default: return "machine-off";
  }
}

/**
 * Two inline stateful toggles: the connection, and the keyboard.
 *
 * `data-on` like `focusToggle`, because each changes what the pane IS and has to be readable without
 * opening a menu — the grab especially, since it changes what EVERY key does and a person who
 * cannot see that it is on has no way to work out why ⌘T stopped opening a terminal. Both carry
 * `aria-pressed` and NOT a state in the name: design.md is explicit that a toggle takes one or the
 * other, never both.
 *
 * Grab is default OFF, and that is a decision about whose muscle memory wins. Realm's global hotkeys
 * run on `window` and `preventDefault`, so ⌘T opens a Realm terminal rather than reaching the guest
 * — and a Realm user's muscle memory is Realm's until they say otherwise.
 */
export function MachinePanelActions({ item }: { item: Item }) {
  const state = useApp((s) => s.machineState[item.refId]);
  const grabbed = useApp((s) => s.machineGrab[item.refId] === true);
  const setGrab = useApp((s) => s.setMachineGrab);
  const status = state?.status ?? "off";
  const on = status === "running" || status === "booting";
  const toggle = () => { void rpc().call(on ? "machines.stop" : "machines.start", { machineId: item.refId }).catch(() => {}); };
  return (<>
    {/* Only while there is a screen to send keys to. A grab toggle on a pane showing a connect form
        would change what every key does for no reason anybody could see. */}
    {status === "running" && (
      <button className="icon-btn" aria-label={`Send keystrokes to ${item.title}`} aria-pressed={grabbed}
        data-on={grabbed || undefined} title={grabbed ? "Realm's shortcuts are off" : "Grab keyboard"}
        onClick={() => setGrab(item.refId, !grabbed)}>
        <Icon name="key" size={14} />
      </button>
    )}
    <button className="icon-btn" aria-label={`Connection to ${item.title}`} aria-pressed={on} data-on={on || undefined}
      title={on ? "Disconnect" : "Connect"} onClick={toggle}>
      <Icon name="plug" size={14} />
    </button>
  </>);
}
