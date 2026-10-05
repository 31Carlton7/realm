import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_AGENT_ATTR } from "@realm/contracts";

/**
 * Which of Realm's own surfaces an agent may never act in.
 *
 * `app_act` can press any button in this window, and some of them grant things: the permission card
 * answers one request, the bypass confirmation escalates the session to a mode where nothing is
 * asked again, the plan approval takes a session out of Plan, and a question card answers for the
 * user. An agent able to press any of them could approve the work it is blocked on. `app-drive.ts`
 * refuses anything inside an element carrying `data-no-agent`, and this is the list of what carries
 * it — written down here so that removing one is a visible act rather than a silent regression in a
 * file about layout.
 *
 * Read as TEXT rather than rendered, deliberately. These components need a session, a store and a
 * permission in flight to render at all, and a test that had to build those would be a test about
 * scaffolding. What is being asserted is one attribute's presence in one file, which is exactly what
 * a reader of that file would check.
 *
 * It is a floor, not a ceiling: a new granting surface must be added to both the component and this
 * list. The failure it prevents is the one where nobody remembers there was a list.
 */

function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}

const SURFACES = [
  {
    what: "the permission card",
    file: "apps/desktop/src/renderer/src/panes/session/PermissionCard.tsx",
    on: 'className="permission-card"',
  },
  {
    what: "the bypassPermissions confirmation",
    file: "apps/desktop/src/renderer/src/panes/session/Composer.tsx",
    on: "bypass-confirm",
  },
  {
    what: "a question put to the user",
    file: "apps/desktop/src/renderer/src/panes/session/QuestionCard.tsx",
    on: 'className="question-card"',
  },
  {
    what: "the plan approval",
    file: "apps/desktop/src/renderer/src/panes/session/PlanCard.tsx",
    on: 'className="plan-decision"',
  },
  /* A question's model field opens a chooser PORTALLED out of the card, so the card's own attribute
     does not reach it: picking a model there is answering for the user, and the chooser carries the
     claim itself whenever a question opens it (`noAgent`). */
  {
    what: "the model chooser a question opens",
    file: "apps/desktop/src/renderer/src/panes/agents-tab/ModelChooser.tsx",
    on: 'className="menu subagents-chooser"',
  },
  {
    what: "a question, after the fact",
    file: "apps/desktop/src/renderer/src/panes/session/QuestionCard.tsx",
    on: 'className="question-answered"',
  },
  /* The three that start paid work in the user's name: an agent pressing them could hand work to
     other models nobody asked for. Opening the Agents tab with a plan is the first step of that, so
     its two doors are guarded as well as the send that completes it. */
  {
    what: "the Agents tab's Build with composer",
    file: "apps/desktop/src/renderer/src/panes/agents-tab/AgentsTab.tsx",
    on: 'className="subagents-compose"',
  },
  {
    what: "a plan's Implement with…",
    file: "apps/desktop/src/renderer/src/panes/session/PlanCard.tsx",
    on: "plan-implement-with",
  },
  {
    what: "an answer's Implement with…",
    file: "apps/desktop/src/renderer/src/panes/session/MessageActions.tsx",
    on: "msg-implement-with",
  },
  /* A view an MCP server drew asking, through Realm, to run one of its tools, to put words in the
     prompter, or to open a page. The user's click is the whole gate, so an agent able to press it
     would be the agent running the vendor's tool for itself. */
  {
    what: "a view's request, held for the user",
    file: "apps/desktop/src/renderer/src/panes/app-view/ViewRequestCard.tsx",
    on: 'className="app-view-request"',
  },
];

describe("surfaces no agent may act in", () => {
  it.each(SURFACES)("$what carries the attribute", ({ file, on }) => {
    const src = readFileSync(repoFile(file), "utf8");
    // The attribute and the element it guards on the same element, not merely both in the file: a
    // `data-no-agent` that drifted onto a sibling guards nothing.
    const element = src.split("\n").find((line) => line.includes(on) && line.includes("<"));
    expect(element, `no element in ${file} matching ${on}`).toBeDefined();
    expect(element).toContain(NO_AGENT_ATTR);
  });

  it("names the attribute main actually looks for", () => {
    // THE MUTANT: change the constant. Every component would keep its now-meaningless attribute and
    // every one of these surfaces would silently become clickable.
    expect(NO_AGENT_ATTR).toBe("data-no-agent");
  });
});
