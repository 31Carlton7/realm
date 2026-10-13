import { CONNECTORS, type Connector } from "./connectors";
import type { RiskClass } from "./risk-class";

/**
 * Realm's own reading of what the connectors it offers can do, tool by tool (the dynamic-Teams plan,
 * §4.2, source 3). Data, reviewed like code: a tool listed here is classed by this table rather than
 * by what its server says about itself, and the verb floor still applies on top.
 *
 * Keyed by the connector's id in `CONNECTORS`, and matched to a server row by its URL's host, so a
 * vendor that moves its endpoint moves here through `CONNECTORS` and nowhere else. Only tools whose
 * names were read off the vendor's own server list are here; a tool missing from the table falls
 * through to its annotations, and from there to unclassified. Connectors Realm offers but has no
 * table for (Slack, Jira & Confluence, Sentry) are classed by their annotations alone.
 */
const R: RiskClass = "read";
const U: RiskClass = "reversible-external";
const X: RiskClass = "irreversible-external";

const rows = (cls: RiskClass, names: string): [string, RiskClass][] => names.trim().split(/\s+/).map((n) => [n, cls]);

export const VENDOR_TOOL_CLASSES: Readonly<Record<string, Readonly<Record<string, RiskClass>>>> = {
  linear: Object.fromEntries([
    ...rows(R, `extract_images get_agent_skill get_attachment get_diff get_diff_threads get_document get_issue get_issue_status
      get_milestone get_notifications get_project get_release get_release_note get_status_updates get_team get_template
      get_triage_responsibility get_user get_workspace list_agent_skills list_comments list_custom_views list_cycles list_diffs
      list_documents list_issue_labels list_issue_statuses list_issues list_milestones list_project_labels list_projects
      list_release_notes list_release_pipelines list_releases list_teams list_templates list_users search_documentation`),
    ...rows(U, `create_attachment create_attachment_from_upload create_issue_label mark_notification prepare_attachment_upload
      resolve_diff_thread restore_issue_label restore_project_label retire_issue_label retire_project_label save_comment
      save_diff_comment save_document save_issue save_issue_label save_milestone save_project save_project_label save_release
      save_release_note save_status_update unshare_issue update_diff`),
    ...rows(X, `delete_attachment delete_comment delete_diff_comment delete_status_update merge_diff share_issue submit_diff_review`),
  ]),
  notion: Object.fromEntries([
    ...rows(R, `notion-search notion-fetch notion-get-comments notion-get-teams notion-get-users notion-query-data-sources`),
    ...rows(U, `notion-create-pages notion-update-page notion-move-pages notion-duplicate-page notion-create-database
      notion-update-data-source notion-create-view notion-update-view notion-create-comment`),
  ]),
  figma: Object.fromEntries([
    ...rows(R, `get_design_context get_screenshot get_metadata get_variable_defs get_code_connect_map get_figjam
      get_code_connect_suggestions get_context_for_code_connect search_design_system whoami`),
    ...rows(U, `add_code_connect_map send_code_connect_mappings use_figma create_new_file generate_diagram upload_assets`),
  ]),
  github: Object.fromEntries([
    ...rows(R, `get_me get_issue list_issues search_issues get_pull_request list_pull_requests get_pull_request_files
      get_pull_request_status get_pull_request_comments get_pull_request_reviews search_code search_repositories search_users
      get_file_contents list_commits get_commit list_branches list_tags`),
    ...rows(U, `create_issue update_issue add_issue_comment create_pull_request update_pull_request create_branch
      create_or_update_file push_files create_repository fork_repository request_copilot_review create_pull_request_review`),
    ...rows(X, `merge_pull_request delete_file`),
  ]),
};

const hostOf = (url: string): string | null => { try { return new URL(url).host.toLowerCase(); } catch { return null; } };

/** The connector Realm offers at this host, or undefined. */
export function connectorAtHost(host: string): Connector | undefined {
  const h = host.toLowerCase();
  return CONNECTORS.find((c) => hostOf(c.url) === h);
}

/** The vendor table's class for a tool on the server at `host`, or null when the table says nothing. */
export function vendorToolClass(host: string, tool: string): RiskClass | null {
  const c = connectorAtHost(host);
  return (c && VENDOR_TOOL_CLASSES[c.id]?.[tool]) ?? null;
}
