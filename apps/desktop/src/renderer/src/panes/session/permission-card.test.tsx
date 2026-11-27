import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("says a password fill's always is for this site, and only where it is kept", () => {
    expect(labels(card({ toolName: "browser_fill_credential", title: "Fill", input: { origin: "https://example.com", page: "https://example.com" } }).options))
      .toEqual(["Allow", "Always allow on this site", "Deny"]);
    cleanup();
    expect(labels(card({ toolName: "browser_fill_credential", title: "Fill", input: { origin: "https://example.com", always: false } }).options))
      .toEqual(["Allow", "Allow always", "Deny"]);
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
    expect(options.map((o) => o.querySelector(".permission-option-kbd")!.textContent)).toEqual(["↵", "⇧↵", "⌘⌫"]);
  });

  it("offers no always on a security-code fill, by click, digit or chord", () => {
    const { options, decided, root } = card({ toolName: "browser_fill_code", title: "Fill the security code" });
    expect(labels(options)).toEqual(["Allow", "Deny"]);
    fireEvent.keyDown(root, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(root, { key: "2" });
    fireEvent.keyDown(root, { key: "3" });
    expect(decided).toEqual(["allow", "deny"]);
  });

  it("does not relabel a tool that merely looks like one", () => {
    expect(labels(card({ toolName: "computer_snapshot" }).options)).toEqual(["Allow", "Allow always", "Deny"]);
  });
});

describe("a password fill while agent sign-ins are off", () => {
  const offer = { toolName: "browser_fill_credential", title: "Fill", input: { origin: "https://example.com", page: "https://example.com", offersSignins: true } };
  const saved = window.realm;
  afterEach(() => { (window as unknown as { realm: unknown }).realm = saved; });
  /** Settings' own IPC to main's switch, stood in. */
  function bridge(answer: () => Promise<unknown>) {
    const sets: boolean[] = [];
    const codes: boolean[] = [];
    (window as unknown as { realm: unknown }).realm = { ...saved, credentials: {
      setSignins: async (on: boolean) => { sets.push(on); return answer(); },
      setCodes: async (on: boolean) => { codes.push(on); return { enabled: on, sources: null }; },
    } };
    return { sets, codes };
  }

  it("offers Allow once, Turn on sign-ins and Deny", () => {
    expect(labels(card(offer).options)).toEqual(["Allow once", "Turn on sign-ins", "Deny"]);
  });

  it("turns sign-ins on in main first, then answers Allow once, so the fill needs no second card", async () => {
    // THE MUTANT: answering before main's switch is on, or never answering after it.
    const { sets } = bridge(async () => ({ enabled: true, fills: [] }));
    const { options, decided } = card(offer);
    fireEvent.click(options[1]!);
    expect(decided).toEqual([]);
    await waitFor(() => expect(decided).toEqual(["allow"]));
    expect(sets).toEqual([true]);
  });

  it("turns Security codes on too, as the Settings switch does", async () => {
    // THE MUTANT: the card turning on sign-ins alone, leaving the codes a sign-in's second step needs off.
    const { codes } = bridge(async () => ({ enabled: true, fills: [] }));
    const { options, decided } = card(offer);
    fireEvent.click(options[1]!);
    await waitFor(() => expect(decided).toEqual(["allow"]));
    expect(codes).toEqual([true]);
  });

  it("answers nothing when main did not turn sign-ins on, and says so", async () => {
    bridge(async () => null);
    const { options, decided, root } = card(offer);
    fireEvent.keyDown(root, { key: "Enter", shiftKey: true });
    expect(await within(root).findByRole("alert")).toHaveTextContent("Realm couldn't turn on sign-ins");
    expect(decided).toEqual([]);
    fireEvent.click(options[0]!);
    expect(decided).toEqual(["allow"]);
  });
});

describe("the invitation to turn agent sign-ins on", () => {
  it("opens Settings or goes away, and has no Allow to give", () => {
    const { options, decided } = card({ toolName: "agent_signins", title: "Let agents finish sign-ins? Opens Settings", input: { opens: "settings:signins" } });
    expect(labels(options)).toEqual(["Open Settings", "Not now"]);
    fireEvent.click(options[1]!);
    expect(decided).toEqual(["deny"]);
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

describe("what the card says, and how many times", () => {
  const bash: PendingPermission = { requestId: "r1", toolName: "Bash", input: { command: "pnpm --filter @realm/desktop dist" }, title: "Allow Bash?" };

  it("says who is asking first, by the teammate's name when the session is a teammate's", () => {
    // The head read "Allow Bash?" and nothing else, so a card in Needs you never said whose it was.
    render(<PermissionCard permission={bash} asker={{ kind: "agent", name: "Release Captain", agent: "claude" }} onDecide={() => {}} />);
    expect(document.querySelector(".permission-from")!.textContent).toBe("Release Captain asks");
  });

  it("shows the command once and never says Waiting in words", () => {
    // It printed the command three times — the tool row, a "Bash pnpm …" line, the `$ pnpm …` well —
    // and wore a Waiting pill beside the tool row's own "Waiting for you".
    const { container } = render(<PermissionCard permission={bash} asker={{ kind: "agent", name: "Claude", agent: "claude" }} onDecide={() => {}} />);
    // The raw payload under the closed "Raw input" fold is the checking copy, not a second showing.
    const shown = container.cloneNode(true) as HTMLElement;
    shown.querySelector(".permission-details")!.remove();
    const text = shown.textContent ?? "";
    expect(text.split("pnpm --filter @realm/desktop dist").length - 1).toBe(1);
    expect(container.querySelector(".permission-tool")).toBeNull();
    expect(text).not.toMatch(/Waiting/);
  });

  it("keeps the one-line summary for a tool the card has no drawing for", () => {
    render(<PermissionCard permission={{ requestId: "r2", toolName: "mcp__x__thing", input: { q: "a" }, title: "Allow thing?" }} onDecide={() => {}} />);
    expect(document.querySelector(".permission-tool")).not.toBeNull();
  });
});
