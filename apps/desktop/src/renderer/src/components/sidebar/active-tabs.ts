import type { Layout } from "@realm/contracts";
/** Ids of the tab that is active in each leaf. */
export function activeTabIds(l: Layout | null): Set<string> {
  const out = new Set<string>();
  const walk = (n: Layout) => { if (n.type === "leaf") { if (n.activeTab) out.add(n.activeTab); } else n.children.forEach(walk); };
  if (l) walk(l);
  return out;
}
