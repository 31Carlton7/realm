import type { Item } from "@realm/contracts";
import type { MenuItem } from "../components/Menu";
import type { ComponentType, JSX } from "react";
import { PlaceholderPane } from "./PlaceholderPane";
import { SessionMeta, SessionPanelActions } from "./session/SessionPane";
import { MachineMeta, MachinePanelActions, useMachineMenuItems } from "./machine/MachineBar";
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
  terminal: TerminalMeta, // "Replayed" or "Not running", and nothing at all while the pane is live
};

/** Optional per-kind icon buttons in the PanelBar's action cluster, left of the ⋯ menu. */
export const paneActions: Partial<Record<Item["kind"], (p: { item: Item }) => JSX.Element | null>> = {
  session: SessionPanelActions, // branch/diff + the session's own terminal drawer (Ara refresh §6)
  machine: MachinePanelActions, // one lit toggle: connected or not (Plan 25 W3)
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
export function usePaneMenuItems(item: Item): MenuItem[] {
  const machine = useMachineMenuItems(item);
  return item.kind === "machine" ? machine : [];
}
