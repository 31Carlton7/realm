import type { AppState } from "./store";
import { pageHidesSidebar } from "./page-item";

/**
 * Whether the spaces sidebar is away: the person's own collapse, or a page that takes it away
 * (`PAGE_SHELL`) — unless they asked for it back on this page, which lasts exactly as long as the
 * page does (`sidebarOnPage` holds that page's own overlay, and the next page is a new one). The one
 * answer the shell, the sidebar, its toggle and a page's rail all read, so none of them can disagree
 * about whether the column is there.
 */
export function sidebarHidden(s: Pick<AppState, "sidebarCollapsed" | "pageOverlay" | "sidebarOnPage">): boolean {
  const page = s.pageOverlay;
  return page && pageHidesSidebar(page.kind) ? s.sidebarOnPage !== page : s.sidebarCollapsed;
}
