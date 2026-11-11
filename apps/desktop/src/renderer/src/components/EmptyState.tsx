import { Icon, type IconName } from "@realm/ui";
import type { ReactNode } from "react";

/**
 * What a page or a pane shows when it has nothing to show: a glyph, a title, one line, and at most
 * one primary action. Every empty view draws through this, because the same moment drawn four ways
 * (a bare sentence, a centred glyph with an action, one without, a dashed tile) read as four kinds of
 * thing, and a dashed frame at rest says "drop something here" where nothing can be dropped.
 *
 * `path` is a folder or file the state is about, in mono under the title. `note` is a quieter line
 * under the actions, for a step the action leaves to the person (what to do in the terminal it opens).
 */
export function EmptyState({ icon, title, path, children, actions, note, heading = "h2", role, className }: {
  icon?: IconName | (string & {});
  title?: ReactNode;
  path?: string;
  children?: ReactNode;
  actions?: ReactNode;
  note?: ReactNode;
  heading?: "h1" | "h2";
  role?: "status";
  className?: string;
}) {
  const Heading = heading;
  return (
    <div className={className ? `empty-state ${className}` : "empty-state"} role={role}>
      {/* off-ladder: the one picture of an empty view, a rung above the 20 a control's glyph stops at,
          drawn alone with no tile round it. */}
      {icon && <Icon name={icon} size={24} className="empty-state-mark" />}
      {title && <Heading className="empty-state-title">{title}</Heading>}
      {path && <p className="empty-state-path">{path}</p>}
      {children && <p className="empty-state-line">{children}</p>}
      {actions && <div className="empty-state-actions">{actions}</div>}
      {note && <p className="empty-state-note">{note}</p>}
    </div>
  );
}
