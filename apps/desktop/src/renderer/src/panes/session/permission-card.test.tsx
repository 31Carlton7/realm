import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PermissionCard } from "./PermissionCard";
import type { PendingPermission } from "./transcript-model";

/**
 * The card's option list, and the one tool whose "always" is not the session's.
 *
 * Everything else about this card — keyboard, ordering, the drawn input — is covered from the pane
 * in `session-pane.test.tsx`. What must die here is the computer-use card promising a scope it does
 * not grant, in either direction.
 */
function card(over: Partial<PendingPermission> = {}) {
  const decided: string[] = [];
  const permission: PendingPermission = {
    requestId: "r1", toolName: "Bash", input: { command: "ls" }, title: "Run ls?", ...over,
  };
  render(<PermissionCard permission={permission} onDecide={(d) => decided.push(d)} />);
  const root = screen.getByText(permission.title).closest(".permission-card") ?? document.body;
  const options = within(root as HTMLElement).getAllByRole("button").filter((b) => b.classList.contains("permission-option"));
  return { decided, options, root: root as HTMLElement };
}

const labels = (options: HTMLElement[]): (string | null)[] => options.map((o) => o.getAttribute("aria-label"));

describe("PermissionCard options", () => {
  it("says Allow always for an ordinary tool, whose always is the session", () => {
    expect(labels(card().options)).toEqual(["Allow", "Allow always", "Deny"]);
  });

  it("names the scope on a computer-use card, whose always outlives the session", () => {
    // The grant is written to the space's allowed-apps list. "Allow always" next to "Allow" reads as
    // "for now", and a user answering about an application on their own Mac is owed the real scope.
    expect(labels(card({ toolName: "computer_act", title: "Click in TextEdit" }).options))
      .toEqual(["Allow", "Always allow in this space", "Deny"]);
  });

  it("relabels only that option, and changes no decision", () => {
    // The same three answers reach the server. A fourth decision would have to be understood by
    // every adapter that can receive one, and this is not one.
    const { options, decided } = card({ toolName: "computer_act", title: "Click in TextEdit" });
    expect(options.map((o) => o.getAttribute("data-decision"))).toEqual(["allow", "allow_always", "deny"]);
    for (const option of options) fireEvent.click(option);
    expect(decided).toEqual(["allow", "allow_always", "deny"]);
  });

  it("leaves the numbering and shortcuts alone, so the row order is unchanged", () => {
    const { options } = card({ toolName: "computer_act", title: "Click in TextEdit" });
    expect(options.map((o) => o.querySelector(".permission-num")!.textContent)).toEqual(["1", "2", "3"]);
    expect(options.map((o) => o.querySelector(".permission-option-kbd")!.textContent)).toEqual(["⏎", "⇧⏎", "⌘⌫"]);
  });

  it("does not relabel a tool that merely looks like one", () => {
    expect(labels(card({ toolName: "computer_snapshot" }).options)).toEqual(["Allow", "Allow always", "Deny"]);
  });
});

describe("the computer-use card's own words", () => {
  it("names the app on the title, which is what the user is deciding about", () => {
    vi.stubGlobal("scrollTo", () => {});
    card({ toolName: "computer_act", title: 'Type "hello" into TextEdit' });
    expect(screen.getByText('Type "hello" into TextEdit')).toBeTruthy();
  });
});
