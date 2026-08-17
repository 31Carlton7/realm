import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaneHost } from "./PaneHost";
import type { Item, Layout } from "@realm/contracts";

const items: Item[] = [
  { id: "A", spaceId: "s", kind: "browser", title: "Tab A", sortOrder: 0, pinned: false, refId: "A", createdAt: 0, updatedAt: 0 },
  { id: "B", spaceId: "s", kind: "artifact", title: "Tab B", sortOrder: 1, pinned: false, refId: "B", createdAt: 0, updatedAt: 0 },
  { id: "C", spaceId: "s", kind: "context", title: "Tab C", sortOrder: 2, pinned: false, refId: "C", createdAt: 0, updatedAt: 0 },
];

describe("PaneHost", () => {
  it("renders leaves for a nested split and shows active tab content", () => {
    const layout: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
      { type: "leaf", id: "L1", tabs: ["A", "B"], activeTab: "B" },
      { type: "leaf", id: "L2", tabs: ["C"], activeTab: "C" },
    ] };
    render(<PaneHost layout={layout} items={items} onActivate={() => {}} onClose={() => {}} onSplit={() => {}} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Tab B" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Tab A" })).toHaveAttribute("aria-selected", "false");
    // placeholder pane content mentions the item kind
    expect(screen.getByText(/artifact pane/i)).toBeInTheDocument();
    expect(screen.getByText(/context pane/i)).toBeInTheDocument();
  });
  it("renders an empty-state for an empty leaf", () => {
    render(<PaneHost layout={{ type: "leaf", id: "L", tabs: [], activeTab: null }} items={[]} onActivate={() => {}} onClose={() => {}} onSplit={() => {}} />);
    expect(screen.getByText(/nothing open/i)).toBeInTheDocument();
  });
});
