import type { Item } from "@realm/contracts";
import type { MenuItem } from "../components/Menu";
import type { ComponentType, JSX } from "react";
import { PlaceholderPane } from "./PlaceholderPane";
import { SessionMeta, SessionPanelActions, useSessionMenuItems } from "./session/SessionPane";
import { MachineMeta, MachinePanelActions, useMachineMenuItems } from "./machine/MachineBar";
import { SimulatorMeta, SimulatorPanelActions } from "./simulator/SimulatorBar";
import { TerminalMeta } from "./TerminalMeta";

/** `focused`: the pane sits in the focused leaf (keyboard target — e.g. permission autofocus). */
export type PaneProps = { item: Item; visible: boolean; focused?: boolean };
const registry: Partial<Record<Item["kind"], ComponentType<PaneProps>>> = {};
export function registerPane(kind: Item["kind"], c: ComponentType<PaneProps>) { registry[kind] = c; }
export function PaneFor(props: PaneProps) {
  const C = registry[props.item.kind] ?? PlaceholderPane;
  return <C {...props} />;
}

/** Optional right-side PanelBar content per item kind. */
export const paneMeta: Partial<Record<Item["kind"], (p: { item: Item }) => JSX.Element | null>> = {
  session: SessionMeta, // model label + status dot + cost, moved out of SessionPane's old header
  machine: MachineMeta,  // the state word, and the guest's live resolution in mono (Plan 25 W3)
  simulator: SimulatorMeta, // the same pair for a device: what the stream is doing, and its resolution
  terminal: TerminalMeta, // "Replayed" or "Not running", and nothing at all while the pane is live
};

/**
 * Optional per-kind icon buttons in the PanelBar's action cluster, left of the ⋯ menu.
 *
 * `keep` is how many of them the bar still has room to DRAW (components/pane-bar-fit.ts). The kind
 * renders that many and hands the rest to its own `usePaneMenuItems` below, which is why both take
 * the same number: one budget, two halves of one cluster, and no way for them to disagree about
 * where a given action currently is. A kind whose bar has no ⋯ to overflow into — the browser's —
 * is given `Infinity` by PanelBar and keeps every button.
 */
export const paneActions: Partial<Record<Item["kind"], (p: { item: Item; keep: number }) => JSX.Element | null>> = {
  session: SessionPanelActions, // branch/diff + the session's own terminal drawer (Ara refresh §6)
  machine: MachinePanelActions, // one lit toggle: connected or not (Plan 25 W3)
  simulator: SimulatorPanelActions, // the device's hardware buttons, and the stream's off switch
};

/**
 * Optional per-kind rows in the PanelBar's ⋯ menu, above the layout ones every pane shares.
 *
 * A hook rather than a table of functions, and the reason is React's rules rather than taste: these
 * rows read live store state, and a table indexed by kind would call hooks CONDITIONALLY — no hooks
 * for a session pane, two for a machine. That is stable only for as long as a bar's item kind never
 * changes, which is true today and is not a thing to build a rule on.
 *
 * So every kind's hook is called for every pane, unconditionally and in a fixed order, and the kind
 * decides only which result is USED. The cost is two map lookups on a bar that has no machine in it.
 *
 * `PanelBar` stays kind-agnostic, which is its whole point: a pane bar is the same bar everywhere,
 * and a machine-shaped `if` in it would be the start of the opposite.
 */
export function usePaneMenuItems(item: Item, keep: number): MenuItem[] {
  /* Both hooks, every time, in a fixed order — see the note above. `keep` reaches them because the
     rows an action contributes depend on whether its BUTTON is still in the bar: the overflow is
     the same cluster, continued, not a second copy of it. */
  const session = useSessionMenuItems(item, keep);
  const machine = useMachineMenuItems(item, keep);
  if (item.kind === "session") return session;
  return item.kind === "machine" ? machine : [];
}
