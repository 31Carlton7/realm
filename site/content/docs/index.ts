import type { DocGroup } from "@/lib/docs-blocks"

import browser from "./browser"
import codeReview from "./code-review"
import computerUse from "./computer-use"
import connections from "./connections-and-skills"
import documents from "./documents-and-library"
import gettingStarted from "./getting-started"
import mobile from "./mobile"
import permissions from "./permissions"
import privacy from "./privacy"
import scheduled from "./scheduled-tasks"
import sessions from "./sessions"
import settings from "./settings-and-shortcuts"
import simulators from "./simulators"
import spaces from "./spaces-and-worktrees"
import subAgents from "./sub-agents"
import teams from "./teams-and-review"
import terminals from "./terminals"
import troubleshooting from "./troubleshooting"

/**
 * The docs, in reading order. Each page is its own module beside this one; the groups and their order
 * are here and nowhere else, and the nav, the docs home and prev/next all read them from here.
 *
 * Everything in these pages is a fact about the shipped app (Realm 2.3), read from its source: the
 * labels are the ones the app shows. When the app changes, the page changes with it.
 */
export const DOCS_SUMMARY =
  "How Realm works, from the first install to a team of agents running on a clock. Written for Realm 2.3."

export const groups: DocGroup[] = [
  { title: "Start here", pages: [gettingStarted] },
  { title: "Work with agents", pages: [spaces, sessions, permissions, subAgents, teams, scheduled] },
  { title: "Beside the session", pages: [browser, documents, terminals, codeReview, computerUse, simulators] },
  { title: "Extend Realm", pages: [connections, mobile] },
  { title: "Reference", pages: [settings, privacy, troubleshooting] },
]
