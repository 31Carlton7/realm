import { Icon, TeammateIcon } from "@realm/ui";
import type { Item, Teammate } from "@realm/contracts";
import { useApp } from "../../state/store";
import { briefLine, teammateOfHome } from "../../state/teammates-slice";
import type { MenuItem } from "../../components/Menu";

/** The teammate a pane is the chat of: a `session` item whose session is a teammate's home. */
export function useTeammateOfItem(item: Item): Teammate | null {
  return useApp((s) => (item.kind === "session" ? teammateOfHome(s.teammates, item.refId, item.spaceId) : null));
}

/**
 * A teammate's chat is headed by the teammate, not by its session: the icon, the name, and the one
 * line of what it does, in the place a session's space › title crumb stands. The name is the
 * teammate's, so it is changed by Edit, never renamed in the bar.
 */
export function TeammateHead({ teammate: t }: { teammate: Teammate }) {
  const role = briefLine(t.brief);
  return (
    <span className="tm-head" title={role || undefined}>
      <TeammateIcon icon={t.icon} size={24} lead={t.lead} />
      <span className="tm-head-name">{t.name}</span>
      {role && <span className="tm-head-role">{role}</span>}
    </span>
  );
}

/** A teammate's own rows — its sidebar row's menu and the top of its chat's: Edit, its computer,
 *  Lead or not, Archive. Empty for no teammate, so a pane bar can call it for every pane. */
export function useTeammateMenu(t: Teammate | null): MenuItem[] {
  const openSheet = useApp((s) => s.openSheet);
  const setTeamLead = useApp((s) => s.setTeamLead);
  const archiveTeammate = useApp((s) => s.archiveTeammate);
  const showTeammateComputer = useApp((s) => s.showTeammateComputer);
  const run = useApp((s) => s.run);
  if (!t) return [];
  return [
    { label: "Edit…", icon: <Icon name="edit" size={14} />, onSelect: () => openSheet({ kind: "teammate", spaceId: t.spaceId, id: t.id }) },
    { label: "Computer", icon: <Icon name="computer" size={14} />, detail: "What it is doing on this Mac, and what it finished", onSelect: () => run(() => showTeammateComputer(t.id)) },
    t.lead
      ? { label: "Not the Lead", icon: <Icon name="star" size={14} />, onSelect: () => run(() => setTeamLead(t.spaceId, null)) }
      : { label: "Make Lead", icon: <Icon name="star" size={14} />, onSelect: () => run(() => setTeamLead(t.spaceId, t.id)) },
    { kind: "separator" },
    { label: "Archive", icon: <Icon name="archive" size={14} />, title: "Leaves the Team list; its sessions stay", onSelect: () => run(() => archiveTeammate(t)) },
  ];
}
