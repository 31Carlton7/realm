import type { Item } from "@realm/contracts";
import { PLATFORM_CHORDS } from "@realm/contracts";
import type { MenuItem } from "../../components/Menu";
import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";
import { rpc } from "../../rpc/client";
import { parseChord } from "@realm/contracts";
import { getMachineHub, machineHubInstalled } from "./machine-hub";
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

/**
 * The machine pane's own rows in the ⋯ menu (Plan 25 W7).
 *
 * Three groups, and each exists because of something the platform or the protocol will not do:
 *
 *   - **Send key ▸.** ⌘Q, ⌘Tab and ⌘Space are menu accelerators and window-server chords, and a menu
 *     accelerator fires in MAIN before the renderer sees a keydown — `hotkeys.ts` writes that down
 *     for ⌘W. So no amount of grabbing the keyboard can deliver them, and the pane must not pretend
 *     otherwise. Sending them deliberately is what every remote-desktop client does.
 *   - **Clipboard ▸, two explicit actions and no automatic sync.** RFB's clipboard is latin-1
 *     historically and extended only where both ends speak the pseudo-encoding, so it cannot pretend
 *     to be transparent. And automatic Mac→guest sync would silently push whatever is on the user's
 *     clipboard into a machine that may be running anything — send-then-⌘V is the two-step every
 *     client uses, and it is a two-step on purpose.
 *   - **Scale.** Fit is the default because a remote screen is a thing you want all of; Actual size
 *     is the only mode where `image-rendering: pixelated` is honest, and the bar says which.
 */
export function useMachineMenuItems(item: Item): MenuItem[] {
  /* A HOOK, and called unconditionally by `usePaneMenuItems` for every pane kind — see the note
     there. Reading the store any other way from a plain function would either re-render every pane
     bar on any state change, or read a snapshot that goes stale the moment the menu is open. */
  const scale = useApp((s) => s.machineScale[item.refId]) ?? "fit";
  const setScale = useApp((s) => s.setMachineScale);
  /* The hub is reached LAZILY, inside the handlers, and never while building the menu. It is a
     module singleton built over the RPC client, and constructing one during every pane bar's render
     would build it in panes that have no machine in them — including in a renderer that has no
     server to talk to at all, which is what a test is. */
  const connected = machineHubInstalled() && getMachineHub().isConnected(item.refId);
  const send = (chord: string) => {
    const entry = getMachineHub().entry(item.refId);
    if (!entry) return;
    const parsed = parseChord(chord);
    if (!parsed) return;
    // Down in order, key, up in reverse — a guest that received them any other way sees a chord it
    // was never sent. noVNC's `sendKey` takes a keysym and a `down` flag, which is the same shape.
    for (const m of parsed.modifiers) entry.rfb.sendKey(m, null, true);
    entry.rfb.sendKey(parsed.key, null, true);
    entry.rfb.sendKey(parsed.key, null, false);
    for (const m of [...parsed.modifiers].reverse()) entry.rfb.sendKey(m, null, false);
  };
  const paste = async () => {
    const entry = getMachineHub().entry(item.refId);
    if (!entry) return;
    /* Through main rather than `navigator.clipboard`, which needs a user-gesture heuristic the
       renderer cannot reliably satisfy from inside a menu selection. A menu click IS a gesture, but
       whether Chromium counts one that has already closed a popover is not something to depend on. */
    const text = await window.realm?.clipboard?.readText?.().catch(() => "") ?? "";
    if (text) entry.rfb.clipboardPasteFrom(text);
  };
  return [
    {
      label: "Send key",
      disabled: !connected,
      // A submenu would be a second surface for six rows; the chords are named inline instead, which
      // is also how they read in every other client's menu.
      onSelect: () => { /* the parent row is a heading — the chords below are the actions */ },
      keepOpen: true,
    },
    ...PLATFORM_CHORDS.map((c) => ({
      label: `   ${c.label}`,
      disabled: !connected,
      onSelect: () => send(c.chord),
    })),
    { kind: "separator" as const },
    /* Fit is the default because a remote screen is a thing you want all of. Actual size is the only
       mode where `image-rendering: pixelated` is honest — everywhere else there is real resampling,
       and claiming sharpness over it looks worse than the resampling it disowns. */
    { label: "Scale to fit", checked: scale === "fit", onSelect: () => setScale(item.refId, "fit") },
    { label: "Actual size", checked: scale === "actual", onSelect: () => setScale(item.refId, "actual") },
    { kind: "separator" as const },
    {
      label: "Paste into this machine",
      disabled: !connected,
      title: "Sends your clipboard, then press ⌘V in the guest. RFB's clipboard is not transparent, so this is deliberate rather than automatic.",
      onSelect: () => { void paste(); },
    },
  ];
}
