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

  it("keeps the always answer on a request that does not say once, and answers Shift+Enter with it", () => {
    const { options, decided, root } = card();
    expect(options.map((o) => o.getAttribute("data-decision"))).toEqual(["allow", "allow_always", "deny"]);
    fireEvent.keyDown(root, { key: "Enter", shiftKey: true });
    expect(decided).toEqual(["allow_always"]);
  });
});

/** A request that whoever raised it marked `once`. There is no "always" to keep, so the card has two rows. */
const once = () => card({ toolName: "Workflow", input: { script: "export const meta = { name: 'probe-run', description: 'Probe run' }\nreturn await agent('go')" }, title: "Allow Workflow?", once: true });

const selected = (root: HTMLElement): string | null => root.querySelector(".permission-option[data-selected]")?.getAttribute("aria-label") ?? null;

describe("a request with no always answer to keep", () => {
  it("offers Allow and Deny alone, numbered as they are drawn, with no row and no key hint for an always answer", () => {
    const { options, root } = once();
    expect(labels(options)).toEqual(["Allow", "Deny"]);
    expect(options.map((o) => o.getAttribute("data-decision"))).toEqual(["allow", "deny"]);
    expect(options.map((o) => o.querySelector(".permission-num")!.textContent)).toEqual(["1", "2"]);
    expect(options.map((o) => o.querySelector(".permission-option-kbd")!.textContent)).toEqual(["⏎", "⌘⌫"]);
    expect(root.textContent).not.toContain("⇧");
  });

  it("denies on key 2, the number its Deny row wears", () => {
    const { decided, root } = once();
    fireEvent.keyDown(root, { key: "2" });
    expect(decided).toEqual(["deny"]);
  });

  it("answers only the digits its rows wear, so key 3 decides nothing and key 1 still allows", () => {
    const { decided, root } = once();
    fireEvent.keyDown(root, { key: "3" });
    expect(decided).toEqual([]);
    fireEvent.keyDown(root, { key: "1" });
    expect(decided).toEqual(["allow"]);
  });

  it("denies when Submit is pressed with Deny selected", () => {
    const { decided, root } = once();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(selected(root)).toBe("Deny");
    fireEvent.click(within(root).getByRole("button", { name: "Submit" }));
    expect(decided).toEqual(["deny"]);
  });

  it("answers Enter on the card with the selected row", () => {
    const { decided, root } = once();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(decided).toEqual(["deny"]);
  });

  it("wraps the arrows over its two rows, in both directions", () => {
    const { root } = once();
    expect(selected(root)).toBe("Allow");
    fireEvent.keyDown(root, { key: "ArrowUp" });
    expect(selected(root)).toBe("Deny");
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(selected(root)).toBe("Allow");
  });

  it("does nothing on Shift+Enter, on the card or on a focused row", () => {
    const { decided, options, root } = once();
    expect(fireEvent.keyDown(root, { key: "Enter", shiftKey: true })).toBe(false);
    options[0]!.focus();
    expect(fireEvent.keyDown(options[0]!, { key: "Enter", shiftKey: true })).toBe(false);
    fireEvent.keyDown(within(root).getByRole("button", { name: "Submit" }), { key: "Enter", shiftKey: true });
    expect(decided).toEqual([]);
  });

  it("still denies on Escape and on ⌘⌫, which never depended on the rows", () => {
    const { decided, root } = once();
    fireEvent.keyDown(root, { key: "Escape" });
    fireEvent.keyDown(root, { key: "Backspace", metaKey: true });
    expect(decided).toEqual(["deny", "deny"]);
  });
});

describe("the simulator input card", () => {
  it("shows the step it was raised by as the agent's intent, under a title naming the device and the session", () => {
    // One card covers the rest of the session on the device, so the step that raised it is the only
    // one the user sees asked about — it has to say what the step is FOR, not where it lands.
    vi.stubGlobal("scrollTo", () => {});
    const { root } = card({
      toolName: "simulator_tap", title: "Tap, swipe and type on iPhone Air for the rest of this session",
      // The intent last: the card finds it by name, not by being the first string in the payload.
      input: { device: "iPhone Air", element: "0.3", intent: "open the Wi-Fi settings" },
    });
    expect(within(root).getByText("open the Wi-Fi settings").tagName).toBe("CODE");
    expect(within(root).getByText("simulator_tap")).toBeTruthy();
  });
});
