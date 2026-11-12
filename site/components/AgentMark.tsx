import { agentMarks, toolMarks, type BrandMark } from "@/lib/agent-marks"

export type AgentId = keyof typeof agentMarks
export type ToolId = keyof typeof toolMarks

/**
 * A vendor's mark, in the text's colour. `tinted` draws it in its maker's own colour where the mark
 * has exactly one; the rest stay ink, because no colour is ever invented for a mark that has none.
 */
function Glyph({ mark, className, tinted }: { mark: BrandMark; className?: string; tinted: boolean }) {
  const paths = typeof mark.d === "string" ? [mark.d] : mark.d
  return (
    <svg
      viewBox={mark.viewBox ?? "0 0 24 24"}
      aria-hidden
      className={className ?? "h-4 w-4"}
      fill={tinted && mark.color ? mark.color : "currentColor"}
      fillRule={mark.evenOdd ? "evenodd" : undefined}
      clipRule={mark.evenOdd ? "evenodd" : undefined}
    >
      {paths.map((d) => (
        <path key={d.slice(0, 32)} d={d} />
      ))}
    </svg>
  )
}

export function AgentMark({ id, className, tinted = false }: { id: AgentId; className?: string; tinted?: boolean }) {
  return <Glyph mark={agentMarks[id]} className={className} tinted={tinted} />
}

export function ToolMark({ id, className, tinted = false }: { id: ToolId; className?: string; tinted?: boolean }) {
  return <Glyph mark={toolMarks[id]} className={className} tinted={tinted} />
}

/** The colour a mark answers hover with, or none. */
export const markColor = (id: AgentId): string | undefined => (agentMarks[id] as BrandMark).color
