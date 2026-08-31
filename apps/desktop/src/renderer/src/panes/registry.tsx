import type { Item } from "@realm/contracts";
import type { ComponentType, JSX } from "react";
import { PlaceholderPane } from "./PlaceholderPane";
import { SessionMeta, SessionPanelActions } from "./session/SessionPane";

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
};

/** Optional per-kind icon buttons in the PanelBar's action cluster, left of the ⋯ menu. */
export const paneActions: Partial<Record<Item["kind"], (p: { item: Item }) => JSX.Element | null>> = {
  session: SessionPanelActions, // branch/diff + the session's own terminal drawer (Ara refresh §6)
};
