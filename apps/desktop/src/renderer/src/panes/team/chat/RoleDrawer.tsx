import { Icon, Realmite, parseRealmiteSpec } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import type { TeamActivity, TeamRole, TeamSpace } from "@realm/contracts";
import { Sheet } from "../../../components/Sheet";
import { useDissolve } from "../../../components/ScrollFades";
import { realmiteState } from "../../../components/sidebar/TeamRows";
import { useApp } from "../../../state/store";
import { HandsOffTo, MentionWake, RoleBudget, RoleGoalPanel } from "../HandoffParts";
import { ROLE_MODE_LABEL, RoleSheet, modelLabel } from "../RoleSheet";
import { wakeSentence } from "../team-format";
import { roleBlurb, roleKind } from "./chat-format";

/**
 * Everything about a teammate that is not the conversation, at the chat's side: its Realmite and what
 * it is for, its brief, its goal, when it wakes, what it may spend and use, who it hands work to, and
 * the records it has been keeping. Each is edited where it is read, as the role's page did.
 */
export function RoleDrawer({ role, team, activity, onClose }: { role: TeamRole; team: TeamSpace; activity: readonly TeamActivity[]; onClose: () => void }) {
  const updateRole = useApp((s) => s.updateRole);
  const run = useApp((s) => s.run);
  const [sheet, setSheet] = useState<"edit" | "duplicate" | "remove" | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useDissolve(body);
  const kind = roleKind(role);
  return (
    <div className="tc-drawer-in">
      <div className="tc-drawer-bar">
        <span className="tc-drawer-title">Details</span>
        <button type="button" className="icon-btn" aria-label="Close the details" title="Close the details" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>
      <div className="tc-drawer-body" ref={body}>
        <div className="tc-who">
          <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={160} state={realmiteState(role)} title={`${role.name}'s Realmite`} />
          <span className="tc-who-name">{role.name}</span>
          {kind && <span className="tc-who-kind">{kind}</span>}
          <span className="tc-who-line">{roleBlurb(role)}</span>
          <button type="button" className="btn" onClick={() => setSheet("edit")}>Edit…</button>
        </div>

        <h3 className="settings-head">Instructions</h3>
        <BriefEditor role={role} />

        <h3 className="settings-head">Goal</h3>
        <RoleGoalPanel role={role} />

        <h3 className="settings-head">Wakes</h3>
        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">{role.cron ? wakeSentence(role.cron) : "When you message it"}</span>
              {role.cron && <span className="settings-row-detail">{role.pausedWhy ?? "Does what its brief says is due"}</span>}
            </div>
            {role.cron && (
              <input type="checkbox" role="switch" className="switch" checked={role.scheduleEnabled} aria-label={`${wakeSentence(role.cron)}, on`}
                onChange={(e) => run(() => updateRole({ id: role.id, scheduleEnabled: e.target.checked }).then(() => undefined))} />
            )}
          </li>
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">When you answer one of its reviews</span>
              <span className="settings-row-detail">Send back goes to the run that made it</span>
            </div>
            <input type="checkbox" role="switch" className="switch" checked={role.wakeOnReview} aria-label="When you answer one of its reviews, on"
              onChange={(e) => run(() => updateRole({ id: role.id, wakeOnReview: e.target.checked }).then(() => undefined))} />
          </li>
          <MentionWake role={role} />
        </ul>

        <h3 className="settings-head">Budget</h3>
        <ul className="settings-list"><RoleBudget role={role} /></ul>

        <h3 className="settings-head">Tools and permissions</h3>
        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">{modelLabel(role.model)}</span>
              <span className="settings-row-detail">{ROLE_MODE_LABEL} · the team's policies still ask before it acts</span>
            </div>
          </li>
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">Can use</span>
              <span className="settings-row-detail">{["Records and Review", ...role.skills.map((s) => `the ${s} skill`)].join(", ")}</span>
            </div>
            <button type="button" className="btn-quiet" onClick={() => setSheet("edit")}>Edit</button>
          </li>
          <HandsOffTo role={role} team={team} />
        </ul>

        <h3 className="settings-head">Records it keeps</h3>
        <RecordsKept role={role} spaceId={team.spaceId} activity={activity} />

        <div className="tp-danger">
          <button type="button" className="btn-quiet danger" onClick={() => setSheet("remove")}>Remove {role.name} from the team…</button>
        </div>
      </div>
      <RoleSheets role={role} team={team} sheet={sheet} onClose={() => setSheet(null)} />
    </div>
  );
}

/** The records its runs changed, newest first, each one click from its page. */
function RecordsKept({ role, spaceId, activity }: { role: TeamRole; spaceId: string; activity: readonly TeamActivity[] }) {
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const seen = new Set<string>();
  const kept: { path: string; name: string }[] = [];
  for (const a of activity) {
    const path = typeof a.detail.path === "string" ? a.detail.path : null;
    if (a.verb !== "updated_record" || a.actor !== `role:${role.id}` || !path || seen.has(path)) continue;
    seen.add(path);
    kept.push({ path, name: a.object ?? path });
  }
  if (kept.length === 0) return <p className="tp-empty">None yet. What it learns about the people the team works with goes in a record.</p>;
  return (
    <ul className="tc-records">
      {kept.slice(0, 8).map((r) => (
        <li key={r.path}>
          <button type="button" className="tc-record-link" onClick={() => setSpacePageTab(spaceId, `record:${r.path}`)}>
            <Icon name="records" size={16} /><span>{r.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A role's sheets: edit, duplicate, and the confirm that removes it. */
export function RoleSheets({ role, team, sheet, onClose }: { role: TeamRole; team: TeamSpace; sheet: "edit" | "duplicate" | "remove" | null; onClose: () => void }) {
  const archiveRole = useApp((s) => s.archiveRole);
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const run = useApp((s) => s.run);
  if (sheet === "edit") return <RoleSheet spaceId={role.spaceId} role={role} team={team} onClose={onClose} />;
  if (sheet === "duplicate") return <RoleSheet spaceId={role.spaceId} copyOf={role} team={team} onClose={onClose} onMade={(made) => setSpacePageTab(role.spaceId, `role:${made.id}`)} />;
  if (sheet === "remove") {
    return <RemoveRoleSheet role={role} onClose={onClose}
      onRemove={() => run(async () => { await archiveRole(role.id, role.spaceId); onClose(); setSpacePageTab(role.spaceId, "team"); })} />;
  }
  return null;
}

/**
 * Removing a teammate asks first, because a role is an object a stray click would cost: its clock,
 * its brief and its Realmite. It names exactly what goes and what stays — the role stops waking and
 * leaves the team; its runs, its reviews and its lines in Activity stay under its name.
 */
function RemoveRoleSheet({ role, onClose, onRemove }: { role: TeamRole; onClose: () => void; onRemove: () => void }) {
  const live = role.state === "working" || role.state === "waiting" || role.state === "queued";
  return (
    <Sheet title={`Remove ${role.name} from the team?`} onClose={onClose} width={460}>
      <div className="form">
        <div className="tp-remove-who">
          <Realmite spec={parseRealmiteSpec(role.realmite, role.id)} size={32} />
          <span className="tp-card-name">{role.name}</span>
        </div>
        <p className="tp-lede">
          {role.name} stops waking{role.cron ? " and its schedule is deleted" : ""}. Its runs, what it sent to Review and its lines in
          Activity stay, under its name.{live ? " A run already going finishes first." : ""}
        </p>
        <div className="sheet-actions">
          <button type="button" className="btn" onClick={onClose}>Keep {role.name}</button>
          <button type="button" className="btn destructive" onClick={onRemove}>Remove {role.name}</button>
        </div>
      </div>
    </Sheet>
  );
}

/** The brief keeps itself: a pause writes it, leaving the field writes it at once, and the head says
 *  where it stands (design.md, "A document a person writes keeps itself"). */
function BriefEditor({ role }: { role: TeamRole }) {
  const updateRole = useApp((s) => s.updateRole);
  const run = useApp((s) => s.run);
  const [text, setText] = useState(role.brief);
  const [state, setState] = useState<"saved" | "edited" | "saving">("saved");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const save = (value: string) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (value.trim() === role.brief.trim() || !value.trim()) { setState("saved"); return; }
    setState("saving");
    run(async () => { await updateRole({ id: role.id, brief: value }); setState("saved"); });
  };
  useEffect(() => { if (state === "saved") setText(role.brief); }, [role.brief]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = field.current; if (!el) return;
    el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  return (
    <div className="tp-brief-wrap">
      <textarea ref={field} className="tp-brief" value={text} aria-label={`${role.name}'s brief`} spellCheck
        onChange={(e) => { setText(e.target.value); setState("edited"); if (timer.current) clearTimeout(timer.current); const v = e.target.value; timer.current = setTimeout(() => save(v), 1200); }}
        onBlur={() => save(text)} />
      <span className="tp-brief-state" aria-live="polite">{state === "saving" ? "Saving…" : state === "edited" ? "Edited" : "Saved"}</span>
    </div>
  );
}
