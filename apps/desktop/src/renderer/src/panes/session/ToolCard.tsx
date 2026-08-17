import { Icon } from "@realm/ui";
import { useState } from "react";
import type { SessionStatus } from "@realm/contracts";
import type { Block } from "./transcript-model";
import { clip, prettyJson, toolIcon, toolSummary } from "./tool-summary";

type ToolBlock = Extract<Block, { kind: "tool" }>;
type ToolState = "running" | "ok" | "error" | "none";

/** A tool call the agent made: compact row, click to expand input + result. */
export function ToolCard({ block, sessionStatus }: { block: ToolBlock; sessionStatus: SessionStatus }) {
  const [open, setOpen] = useState(false);
  const live = sessionStatus === "running" || sessionStatus === "waiting_permission";
  const state: ToolState = block.result ? (block.result.isError ? "error" : "ok") : live ? "running" : "none";
  const summary = clip(toolSummary(block.name, block.input));
  return (
    <div className="tool-card" data-state={state} data-open={open || undefined}>
      <button className="tool-row" aria-expanded={open} aria-label={`${block.name} tool call`} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronRight" size={12} className="tool-chevron" />
        <Icon name={toolIcon(block.name)} size={14} />
        <span className="tool-name">{block.name}</span>
        <span className="tool-summary" title={summary}>{summary}</span>
        <span className="tool-status" aria-label={state === "running" ? "running" : state === "ok" ? "done" : state === "error" ? "failed" : "no result"}>
          {state === "running" && <Icon name="spinner" size={14} className="spin" />}
          {state === "ok" && <Icon name="checkCircle" size={14} />}
          {state === "error" && <Icon name="errorCircle" size={14} />}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section"><div className="tool-label">Input</div><pre>{prettyJson(block.input)}</pre></div>
          {block.result && <div className="tool-section"><div className="tool-label">{block.result.isError ? "Error" : "Result"}</div><pre data-error={block.result.isError || undefined}>{block.result.content || "(empty)"}</pre></div>}
        </div>
      )}
    </div>
  );
}
