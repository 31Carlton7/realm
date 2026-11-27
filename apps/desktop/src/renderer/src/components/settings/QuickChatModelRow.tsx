import { useEffect } from "react";
import { quickChatModelOf } from "@realm/view";
import { ModelPicker } from "../../panes/session/ModelPicker";
import { useRunCatalog } from "../../panes/schedules/ScheduleRunPicker";
import { useApp } from "../../state/store";

/**
 * What every quick chat (⌥⌘N) starts on: the prompter's own chip and picker, over the models the
 * installed CLIs reported. Unset, it shows the default the server would pick, a quick model on the
 * first agent that can run (`quickChatModelOf`), so the row never says something a chat would not do.
 */
export function QuickChatModelRow({ stored }: { stored: unknown }) {
  const agentProbe = useApp((s) => s.agentProbe);
  const setQuickChatModel = useApp((s) => s.setQuickChatModel);
  const probeAgents = useApp((s) => s.probeAgents);
  const refreshModelCatalog = useApp((s) => s.refreshModelCatalog);
  const toggleModelFavorite = useApp((s) => s.toggleModelFavorite);
  const eggs = useApp((s) => s.easterEggs);
  const run = useApp((s) => s.run);
  useEffect(() => {
    run(() => probeAgents());
    run(() => refreshModelCatalog());
  }, [run, probeAgents, refreshModelCatalog]);

  const pick = quickChatModelOf(stored, agentProbe, agentProbe.map((p) => p.kind));
  const catalog = useRunCatalog(pick.agentKind, pick.model);
  return (
    <div className="settings-row" data-setting="quick-chat-model"
      title="The model each new quick chat starts on. A chat's own picker can still change it for that chat.">
      <div className="settings-row-main">
        <span className="settings-row-name">Quick chat model</span>
        <span className="settings-row-detail">What ⌥⌘N starts on</span>
      </div>
      <ModelPicker kind={pick.agentKind} model={pick.model} agentProbe={catalog.agentProbe} rows={catalog.rows} info={catalog.info} eggs={eggs}
        onToggleFavorite={(key) => run(() => toggleModelFavorite(key))}
        onPick={(agentKind, model) => run(() => setQuickChatModel({ agentKind, model }))} />
    </div>
  );
}
