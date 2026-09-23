import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_AGENT_ATTR } from "@realm/contracts";

/**
 * Which of Realm's own surfaces an agent may never act in.
 *
 * `app_act` can press any button in this window, and two of them grant things: the permission card
 * answers one request, and the bypass confirmation escalates the session to a mode where nothing is
 * asked again. An agent able to press either could approve the work it is blocked on. `app-drive.ts`
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
