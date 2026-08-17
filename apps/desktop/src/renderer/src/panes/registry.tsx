import type { Item } from "@realm/contracts";
import type { ComponentType } from "react";
import { PlaceholderPane } from "./PlaceholderPane";

export type PaneProps = { item: Item; visible: boolean };
const registry: Partial<Record<Item["kind"], ComponentType<PaneProps>>> = {};
export function registerPane(kind: Item["kind"], c: ComponentType<PaneProps>) { registry[kind] = c; }
export function PaneFor(props: PaneProps) {
  const C = registry[props.item.kind] ?? PlaceholderPane;
  return <C {...props} />;
}
