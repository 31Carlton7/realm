import type { DocGroup, DocPage } from "@/lib/docs-blocks"

import browser from "./browser"
import codeReview from "./code-review"
import commandLine from "./command-line"
import computerUse from "./computer-use"
import connections from "./connections-and-skills"
import documents from "./documents-and-library"
import gettingStarted from "./getting-started"
import mobile from "./mobile"
import permissions from "./permissions"
import privacy from "./privacy"
import runOnAServer from "./run-on-a-server"
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
 * Everything in these pages is a fact about the shipped app (Realm 2.4), read from its source: the
 * labels are the ones the app shows. When the app changes, the page changes with it. A page about
 * something that comes after 2.4, such as the command line, says so at its top.
 */
export const DOCS_SUMMARY =
  "How Realm works, from the first install to a team of agents running on a clock. Written for Realm 2.4."

export const groups: DocGroup[] = [
  { title: "Start here", pages: [gettingStarted] },
  { title: "Work with agents", pages: [spaces, sessions, permissions, subAgents, teams, scheduled] },
  { title: "Beside the session", pages: [browser, documents, terminals, codeReview, computerUse, simulators] },
  { title: "Extend Realm", pages: [connections, mobile, commandLine] },
  { title: "Reference", pages: [settings, privacy, troubleshooting] },
]

/**
 * Pages that are built and reachable at their own address but belong to no group, so the nav, the docs
 * home and prev/next leave them out, and search engines are asked not to index them. A page waits
 * here until it is ready to be read, then moves into a group above.
 */
export const unlisted: DocPage[] = [runOnAServer]
