import { PERMISSION_MODES, type TeamAccess } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect } from "react";
import { useApp } from "../../state/store";
import { ChipMenu, permissionMark } from "../../panes/session/Composer";
import type { MenuItem } from "../Menu";

/** Named as `app_act`'s refusal names it: only the person sets a whole team's access. */
const NO_AGENT = "team access setting";

/** The one mode the whole team is on, or null when they differ. */
export function teamAccessShown(access: TeamAccess): string | null {
  if (access.mixed) return null;
  return access.mode ?? access.teammates[0]?.mode ?? null;
}

/**
 * Team access, at the head of the space's Team list: one mode for every teammate in the space, now and
 * for teammates made later. The rungs are the prompter's permission control's, mark and word. A
 * teammate edited on its own afterwards makes the team Mixed, and picking a rung again puts everyone
 * back on it.
 */
export function TeamAccessRow({ spaceId }: { spaceId: string }) {
  const access = useApp((s) => s.teamAccess[spaceId]);
  const loadTeamAccess = useApp((s) => s.loadTeamAccess);
  const setTeamAccess = useApp((s) => s.setTeamAccess);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => loadTeamAccess(spaceId)); }, [run, loadTeamAccess, spaceId]);
  if (!access) return null;
  const shown = teamAccessShown(access);
  const mark = shown ? permissionMark(shown) : null;
  const differ = access.mode ? access.teammates.filter((t) => t.mode !== access.mode).length : 0;
  const items: MenuItem[] = PERMISSION_MODES.map((m) => ({
    label: m.label, checked: (access.mode ?? shown) === m.id, icon: <Icon name={permissionMark(m.id).icon} size={14} />, noAgent: NO_AGENT,
    onSelect: () => run(() => setTeamAccess(spaceId, m.id)),
  }));
  const title = mark ? `Team access: ${mark.label}`
    : access.mode ? `Team access: ${permissionMark(access.mode).label}, ${differ} teammate${differ === 1 ? "" : "s"} set on ${differ === 1 ? "its" : "their"} own`
    : "Team access: teammates are on different modes";
  return (
    <div className="settings-row sb-team-access" data-no-agent={NO_AGENT}>
      <span className="settings-row-name">Team access</span>
      <ChipMenu ariaLabel="Team access" title={title} warning={shown === "bypassPermissions"} icon={mark?.icon} iconSize={14} caret={false}
        placement="down" label={mark?.label ?? "Mixed"} items={items} />
      {shown === "bypassPermissions" && (
        <span className="settings-row-desc">
          Teammates run commands and edit files without asking. They still ask before deleting with rm, signing in, or using another app.
        </span>
      )}
    </div>
  );
}
