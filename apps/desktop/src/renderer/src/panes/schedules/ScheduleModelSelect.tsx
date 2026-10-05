import { useEffect, useMemo } from "react";
import { AGENT_META, AGENT_MODELS, AgentKindSchema, type AgentKind } from "@realm/contracts";
import { useApp } from "../../state/store";
import { groupRows, modelLabel, modelRows } from "../session/model-catalog";

type Option = { value: string; label: string };

const valueOf = (kind: AgentKind, model: string | null) => `${kind}|${model ?? ""}`;

/**
 * A scheduled task's MAIN model, as one menu: the rows the prompter's picker offers, from the shared
 * catalog (`model-catalog.ts`) and grouped the same way, so a task is offered exactly what a session
 * is. The modal hands it a kind and a model and is told when they change, and knows nothing else
 * about where the list comes from.
 *
 * A model that no harness lists any more (renamed, retired, or a probe that has not answered yet)
 * stays selected under its own id rather than being swapped for a neighbour the person never chose.
 */
export function ScheduleModelSelect({ kind, model, onChange }: {
  kind: AgentKind; model: string | null; onChange: (kind: AgentKind, model: string | null) => void;
}) {
  const agentProbe = useApp((s) => s.agentProbe);
  const favorites = useApp((s) => s.modelFavorites);
  const probeAgents = useApp((s) => s.probeAgents);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => probeAgents()); }, [probeAgents, run]);

  const { groups, selected } = useMemo(() => {
    const rows = modelRows({ kind, model, agentProbe, canSwitchAgent: true, favorites });
    const groups = groupRows(rows, { query: "", kind }).map((g) => ({
      label: g.label,
      options: g.rows.map((r): Option => {
        // "Other agents" names each row by its harness, as the picker does.
        const name = g.byHarness ? r.agentLabel : modelLabel(r);
        return { value: valueOf(r.kind, r.modelId), label: r.note ? `${name} (${r.note})` : name };
      }),
    }));
    // The scripted agent, where this Realm runs one. It is never offered for a fresh session, and a
    // check that drives the app with it has to be able to pick it here too.
    if (kind !== "fake" && agentProbe.some((p) => p.kind === "fake")) {
      groups.push({ label: AGENT_META.fake.label, options: AGENT_MODELS.fake.map((m) => ({ value: valueOf("fake", m.id), label: m.label })) });
    }
    const chosen = rows.find((r) => r.selected);
    return { groups, selected: chosen ? valueOf(chosen.kind, chosen.modelId) : valueOf(kind, model) };
  }, [kind, model, agentProbe, favorites]);

  const listed = groups.some((g) => g.options.some((o) => o.value === selected));
  return (
    <select className="sched-select" aria-label="Model" value={selected}
      onChange={(e) => {
        const [k, m] = e.target.value.split("|");
        const parsed = AgentKindSchema.safeParse(k);
        if (parsed.success) onChange(parsed.data, m ? m : null);
      }}>
      {!listed && <option value={selected}>{model ?? AGENT_META[kind].label}</option>}
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}
