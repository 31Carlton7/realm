import { Icon } from "@realm/ui";
import type { Space } from "@realm/contracts";
import { spaceIsPlainFolder, useApp } from "../../state/store";
import type { MenuItem } from "../Menu";
import { useOpenSpacePage } from "./use-sidebar-model";

/**
 * What can be done about a space, from its rail tile or the "···" on the column's title: one list, so
 * the two never disagree. Rename puts the column's title into a field for that space. A space has no
 * archive; Delete space… is the settings page's own, which names what goes before it asks.
 */
export function useSpaceMenu(space: Space | undefined): MenuItem[] {
  const openSpacePage = useOpenSpacePage();
  const selectSpace = useApp((s) => s.selectSpace);
  const renameSpaceInColumn = useApp((s) => s.renameSpaceInColumn);
  const newSessionInstant = useApp((s) => s.newSessionInstant);
  const askNewWorktree = useApp((s) => s.askNewWorktree);
  const openSheet = useApp((s) => s.openSheet);
  const setSpaceSessionsView = useApp((s) => s.setSpaceSessionsView);
  const setSidebarLens = useApp((s) => s.setSidebarLens);
  const plainFolder = useApp((s) => (space ? spaceIsPlainFolder(s, space.id) : true));
  const run = useApp((s) => s.run);
  if (!space) return [];
  const reveal = window.realm?.files?.reveal;
  return [
    { label: "New session", icon: <Icon name="edit" size={16} />, onSelect: () => run(() => newSessionInstant(null, undefined, space.id)) },
    // A plain folder has no worktrees (store.ts).
    ...(plainFolder ? [] : [
      { label: "New session in a worktree…", icon: <Icon name="branch" size={16} />, onSelect: () => run(() => askNewWorktree(space.id)) },
    ] satisfies MenuItem[]),
    { label: "Add a teammate…", icon: <Icon name="team" size={16} />, onSelect: () => openSheet({ kind: "teammate", spaceId: space.id }) },
    { kind: "separator" },
    { label: "All sessions by time", icon: <Icon name="activity" size={16} />, onSelect: () => run(() => setSidebarLens("recent")) },
    { label: "Archived sessions", icon: <Icon name="archive" size={16} />,
      onSelect: () => { setSpaceSessionsView(space.id, "archived"); openSpacePage(space.id, "sessions"); } },
    ...(reveal ? [{ label: "Show in Finder", icon: <Icon name="folder" size={16} />, onSelect: () => { void reveal(space.folderPath); } }] : []),
    { label: "Connections", icon: <Icon name="connections-page" size={16} />, onSelect: () => openSpacePage(space.id, "connections") },
    { label: "Memory", icon: <Icon name="context" size={16} />, onSelect: () => openSpacePage(space.id, "memory") },
    ...(plainFolder ? [] : [{ label: "Worktrees", icon: <Icon name="branch" size={16} />, onSelect: () => openSpacePage(space.id, "worktrees") }]),
    { kind: "separator" },
    { label: "Rename…", icon: <Icon name="edit" size={16} />, onSelect: () => run(async () => { await selectSpace(space.id); renameSpaceInColumn(space.id); }) },
    { label: "Space settings", icon: <Icon name="settings" size={16} />, onSelect: () => openSpacePage(space.id, "general") },
    { label: "Delete space…", icon: <Icon name="trash" size={16} />, title: "Space settings asks before anything goes",
      onSelect: () => openSpacePage(space.id, "general") },
  ];
}
