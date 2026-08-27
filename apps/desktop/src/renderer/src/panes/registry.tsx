import type { Item } from "@realm/contracts";
import type { ComponentType, JSX } from "react";
import { PlaceholderPane } from "./PlaceholderPane";
import { SessionMeta } from "./session/SessionPane";

export type PaneProps = { item: Item; visible: boolean };
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
