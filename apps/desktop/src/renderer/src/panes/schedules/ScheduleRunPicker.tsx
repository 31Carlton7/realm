import { useEffect, useMemo } from "react";
import { AGENT_SUPPORTS_PERMISSION_MODES, PERMISSION_MODES, type AgentKind, type ModelInfo, type Schedule } from "@realm/contracts";
import { FALLBACK_AGENT, useApp } from "../../state/store";
import { ModelChipText, ModelPicker, type OverflowGroup } from "../session/ModelPicker";
import {
  chipLabel, chipTitle, effortCurrent, effortOptions, fastModeAvailability, fastModeTip, modelRows,
  type EffortControl, type EffortOptions, type FastAvailability, type FastMode, type ModelRow,
} from "../session/model-catalog";
import type { Draft, RunPermission } from "./schedule-model";

/**
 * What a scheduled task's runs could start on and how, read as the prompter reads it for a session:
 * the same rows, the levels the model takes and its default, and what is known about its fast mode.
 * The scripted agent is offered where this Realm runs one, as the checks that drive the app schedule
 * their work on it.
 */
export type RunCatalog = { rows: ModelRow[]; info: Record<string, ModelInfo>; levels: EffortOptions; fast: FastAvailability; tip: string };

export function useRunCatalog(kind: AgentKind, model: string | null): RunCatalog {
  const agentProbe = useApp((s) => s.agentProbe);
  const favorites = useApp((s) => s.modelFavorites);
  const info = useApp((s) => s.modelInfo);
  const effortSupport = useApp((s) => s.effortSupport);
  const fastSupport = useApp((s) => s.fastSupport);
  return useMemo(() => {
    const rows = modelRows({ kind, model, agentProbe, canSwitchAgent: true, favorites,
      also: agentProbe.some((p) => p.kind === "fake") ? ["fake"] : [] });
    const levels = effortOptions({ kind, model, agentProbe, info: info[rows.find((r) => r.selected)?.key ?? ""], remembered: effortSupport });
    const fast = fastModeAvailability({ kind, model, agentProbe, remembered: fastSupport, rows });
    return { rows, info, levels, fast, tip: fastModeTip(kind, model, agentProbe) };
  }, [kind, model, agentProbe, favorites, info, effortSupport, fastSupport]);
}

/** The permissions a run can start in, in the prompter's words. Full access is not among them: a run
 *  is unattended, and its vocabulary refuses `bypassPermissions` outright (contracts/runs.ts). Plan is
 *  listed only for a task that already holds it, so a setting is never shown as a blank. */
function permissionItems(held: RunPermission | null, set: (id: RunPermission) => void): OverflowGroup["items"] {
  const current = held ?? "default";
  const ids: RunPermission[] = [...(current === "plan" ? ["plan" as const] : []), "default", "acceptEdits"];
  return ids.map((id) => ({
    label: id === "plan" ? "Plan" : PERMISSION_MODES.find((m) => m.id === id)!.label,
    checked: current === id, onSelect: () => set(id),
  }));
}

/**
 * The Schedule a task modal's Model row: the prompter's own chip and picker over the task's draft —
 * the model list with each one's harness, the card with the model's own levels and its default, the
 * bolt, and the permission the runs start in. Only what the harness takes is drawn, as in the
 * prompter; a draft holds all of it until the task is saved (`constraintsOf`).
 */
export function ScheduleRunPicker({ draft, catalog, onChange }: {
  draft: Pick<Draft, "agentKind" | "model" | "effort" | "fastMode" | "permissionMode">;
  catalog: RunCatalog;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const run = useApp((s) => s.run);
  const probeAgents = useApp((s) => s.probeAgents);
  const refreshModelFavorites = useApp((s) => s.refreshModelFavorites);
  const refreshFastSupport = useApp((s) => s.refreshFastSupport);
  const refreshModelCatalog = useApp((s) => s.refreshModelCatalog);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const eggs = useApp((s) => s.easterEggs);
  // What a session pane loads on mount, for a page that may be the first thing opened.
  useEffect(() => {
    run(() => probeAgents());
    run(() => refreshModelFavorites());
    run(() => refreshFastSupport());
    run(() => refreshModelCatalog());
  }, [run, probeAgents, refreshModelFavorites, refreshFastSupport, refreshModelCatalog]);

  const kind = draft.agentKind;
  const effort: EffortControl | undefined = catalog.levels.levels.length === 0 ? undefined
    : { ...catalog.levels, value: draft.effort, onChange: (id) => onChange({ effort: id }) };
  // Nothing has run yet, so nothing has reported: the bolt is the request, and the first run checks it.
  const fast: FastMode | undefined = catalog.fast.state === "none" ? undefined
    : { on: draft.fastMode, state: null, reason: null, requested: null, onChange: (on) => onChange({ fastMode: on }),
        availability: catalog.fast, tip: catalog.tip };
  const overflow = AGENT_SUPPORTS_PERMISSION_MODES[kind]
    ? [{ label: "Permissions", items: permissionItems(draft.permissionMode, (permissionMode) => onChange({ permissionMode })) }]
    : undefined;
  return (
    <ModelPicker kind={kind} model={draft.model} effort={effort} rows={catalog.rows} info={catalog.info}
      onToggleFavorite={(key) => run(() => toggleModelFavorite(key))}
      onPick={(agentKind, model) => onChange({ agentKind, model })} fast={fast} overflow={overflow} eggs={eggs} />
  );
}

/**
 * A saved task's model in the chip's own words — the harness's mark, the model, the level in force
 * (the model's default where the task named none) and the bolt — for its card and its row in the
 * column. The tooltip is the chip's too.
 */
export function ScheduleRunText({ schedule }: { schedule: Schedule }) {
  const c = schedule.constraints;
  const kind = c?.agentKind ?? FALLBACK_AGENT, model = c?.model ?? null;
  const catalog = useRunCatalog(kind, model);
  const label = chipLabel(kind, model, catalog.rows);
  const level = catalog.levels.levels.length > 0 ? effortCurrent({ ...catalog.levels, value: c?.effort ?? null }).choice?.label ?? null : null;
  // Worn as the chip wears it: asked for, of a harness that can be asked, on a model nothing has said cannot.
  const fast = c?.fastMode === true && catalog.fast.state !== "none" && catalog.fast.state !== "unavailable";
  const full = catalog.rows.find((r) => r.selected)?.label ?? label;
  return (
    <span className="sched-model" title={chipTitle(full, kind, level, fast)}>
      <ModelChipText kind={kind} label={label} level={level} fast={fast} />
    </span>
  );
}
