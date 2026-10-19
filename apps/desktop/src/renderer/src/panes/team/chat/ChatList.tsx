import { Icon, Realmite, parseRealmiteSpec } from "@realm/ui";
import { useEffect } from "react";
import type { TeamRole, TeamSpace } from "@realm/contracts";
import { realmiteState, roleStateWords } from "../../../components/sidebar/TeamRows";
import { useApp, type SpacePageTab } from "../../../state/store";
import { ageShort } from "../team-format";
import { chatPreview, landingRole, needsYou, roleKind, type ChatPreview } from "./chat-format";

/** The chat a team tab shows, if it shows one: a teammate's, or the team's landing chat. */
export function chatRoleOf(tab: SpacePageTab, team: TeamSpace | undefined): TeamRole | null {
  if (!team?.enabled) return null;
  if (tab.startsWith("role:")) return team.roles.find((r) => r.id === tab.slice(5)) ?? landingRole(team);
  if (tab === "team" || tab === "roles") return landingRole(team);
  return null;
}

/**
 * The team's chats, a row per teammate as a messenger lists its conversations: the Realmite, the name,
 * the newest line and its time, and what it is doing — working, waiting on you, or finished with
 * something you have not read. Radios with a group of their own, so ↑ and ↓ go from chat to chat and
 * Return goes on into the open chat's prompter.
 */
export function ChatList({ spaceId, team, tab, pick }: { spaceId: string; team: TeamSpace; tab: SpacePageTab; pick: (t: SpacePageTab) => void }) {
  const runsByRole = useApp((s) => s.teamRoleRuns);
  const loadRoleRuns = useApp((s) => s.loadRoleRuns);
  const openSheet = useApp((s) => s.openSheet);
  const run = useApp((s) => s.run);
  const missing = team.roles.filter((r) => !runsByRole[r.id]).map((r) => r.id).join(",");
  useEffect(() => {
    if (missing) run(() => Promise.all(missing.split(",").map((id) => loadRoleRuns(id))).then(() => undefined));
  }, [missing, loadRoleRuns, run]);
  const open = chatRoleOf(tab, team);
  const now = Date.now();
  return (
    <fieldset className="page-rail-list tc-list">
      <legend className="visually-hidden">Chats</legend>
      <span className="page-rail-head" aria-hidden="true">Chats</span>
      {team.roles.map((r) => (
        <ChatRow key={r.id} role={r} group={`team-chat-${spaceId}`} lit={open?.id === r.id} now={now}
          preview={chatPreview(r, runsByRole[r.id], team.reviews)} needs={needsYou(r, team.reviews)} onPick={() => pick(`role:${r.id}`)} />
      ))}
      <button type="button" className="settings-tab page-rail-tab tc-add" onClick={() => openSheet({ kind: "add-teammates", spaceId })}>
        <Icon name="add" size={16} className="page-rail-glyph" />
        <span className="tp-rail-label">Add teammate</span>
      </button>
    </fieldset>
  );
}

function ChatRow({ role, group, lit, now, preview, needs, onPick }: {
  role: TeamRole; group: string; lit: boolean; now: number; preview: ChatPreview; needs: boolean; onPick: () => void;
}) {
  const kind = roleKind(role);
  const unread = role.unread && role.state !== "working" && !needs;
  const said = [role.name, needs ? "needs you" : role.state === "working" ? "working" : roleStateWords(role, now).toLowerCase(), unread ? "unread" : null, preview.text]
    .filter(Boolean).join(", ");
  return (
    <label className="settings-tab page-rail-tab tc-chat-row" data-selected={lit || undefined} data-unread={unread || undefined}>
      <input type="radio" name={group} value={role.id} checked={lit} aria-label={said}
        onChange={onPick}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          document.querySelector<HTMLTextAreaElement>(".tc-composer textarea")?.focus();
        }} />
      <span className="tc-chat-mite"><Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={32} state={realmiteState(role)} /></span>
      <span className="tc-chat-text">
        <span className="tc-chat-top">
          <span className="tc-chat-name">{role.name}</span>
          {kind && <span className="tc-chat-kind">{kind}</span>}
          {preview.ts !== null && preview.tone !== "working" && <time className="tc-chat-time" title={new Date(preview.ts).toLocaleString()}>{ageShort(preview.ts, now)}</time>}
        </span>
        <span className="tc-chat-preview" data-tone={preview.tone}>
          {preview.tone === "working" && <span className="tc-dots" aria-hidden="true"><i /><i /><i /></span>}
          <span className="tc-chat-preview-text">{preview.text}</span>
          {needs ? <span className="status-dot tc-chat-mark" data-status="waiting_permission" aria-hidden="true" />
            : unread ? <span className="status-dot tc-chat-mark" data-status="unseen" aria-hidden="true" /> : null}
        </span>
      </span>
    </label>
  );
}
