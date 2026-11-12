import type { ElementType, ReactNode } from "react"

/**
 * Words over the field, set on a pane of it: the field behind them blurred and dimmed, a hairline lit
 * from above for an edge, and the blur carried a short way past that edge, fading out (globals.css,
 * `.field-panel`). The owner, 10-12: "love the blur around it, just needs to be a bit cleaner and
 * professional looking".
 *
 * The panel is the block the field composes a stop around and keeps its light off (`anchor`, `k:` or
 * `c:`), and it tells the composite pass its corner (`data-field-panel`), which dims the field inside
 * exactly that rounded rect and leaves it alone outside, so nothing smudges round the panel. Without
 * WebGPU it is the same pane over the page's CSS fallback.
 *
 * `className` styles the panel (its padding, its type); `wrapClassName` places it (grid columns).
 */
export function FieldPanel({
  anchor,
  as: Panel = "div",
  radius = 16,
  className = "",
  wrapClassName = "",
  children,
}: {
  anchor?: string
  as?: ElementType
  radius?: 12 | 16
  className?: string
  wrapClassName?: string
  children: ReactNode
}) {
  return (
    <div className={`field-panel-wrap ${wrapClassName}`}>
      <span aria-hidden className="field-feather" />
      <Panel data-field-anchor={anchor} data-field-panel={radius} className={`field-panel ${className}`} style={{ borderRadius: radius }}>
        {children}
      </Panel>
    </div>
  )
}
