import type { Item } from "@realm/contracts";
export function PlaceholderPane({ item }: { item: Item }) {
  return <div className="pane-placeholder"><div>{item.kind} pane</div><div className="muted">"{item.title}" — coming in a later plan</div></div>;
}
