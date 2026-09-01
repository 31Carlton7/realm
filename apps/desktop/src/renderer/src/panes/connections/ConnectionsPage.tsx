import { Icon } from "@realm/ui";
import { useApp } from "../../state/store";
import { McpSection } from "../../components/sidebar/McpSection";
import type { PaneProps } from "../registry";

/**
 * The Connections page (Plan 12 W4): the sidebar destination for MCP servers, on the W3 page pattern.
 * No rail — one section, so the head leads straight into the content column.
 *
 * The body IS McpSection, the same component the space page's Connections tab mounts — scope groups,
 * provider rows, hub status dots, Test, the add/edit form and MCP_SECRET_STORAGE_NOTE all live THERE,
 * once. This page adds only the destination chrome; anything more would be the fork W4 forbids.
 *
 * Vantage: `item.spaceId` — the space whose layout holds the pane (see LibraryPage's twin comment).
 */
export function ConnectionsPage({ item }: PaneProps) {
  const spaceId = item.spaceId;
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));

  if (!space) return <div className="pane-placeholder muted">This page's space no longer exists.</div>;

  return (
    <div className="page connections-page-pane">
      <header className="page-head">
        <span className="page-glyph"><Icon name="connections-page" size={20} /></span>
        <div className="page-title">
          <h1>Connections</h1>
          <span className="page-sub">MCP servers and Realm's own tools, grouped by where each is defined — seen from {space.name}.</span>
        </div>
      </header>
      <div className="page-body">
        <div className="page-content">
          <McpSection spaceId={spaceId} />
        </div>
      </div>
    </div>
  );
}
