import type { PaneProps } from "../registry";
import { AppView } from "./AppView";

/** A view an MCP server drew, as a tab of its session's side pane: the same view as under the tool
 *  call, given the whole pane. The tab's title says whose it is; the pane is the view and nothing else. */
export function AppViewPane({ item }: PaneProps) {
  return (
    <div className="app-view-pane">
      <AppView viewId={item.refId} mode="tab" />
    </div>
  );
}
