import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PendingRequest } from "./PendingRequest";
import type { PendingPermission } from "./transcript-model";

const bash: PendingPermission = { requestId: "r1", toolName: "Bash", input: { command: "rm -rf build" }, title: "Allow Bash?" };
const question: PendingPermission = { requestId: "q1", toolName: "AskUserQuestion", title: "Allow AskUserQuestion?",
  input: { questions: [{ question: "Which branch?", header: "Base", multiSelect: false, options: [{ label: "main" }, { label: "next" }] }] } };
const plan: PendingPermission = { requestId: "p1", toolName: "ExitPlanMode", input: { plan: "# Plan" }, title: "Allow ExitPlanMode?" };

const groupOf = (p: PendingPermission) =>
  p === bash ? "Permission request" : p === question ? "Base" : "Plan approval";

/**
 * Who owns Escape. In the transcript the card does — Escape is Deny, or Skip on a question, and the
 * footer says so. On a surface whose Escape means "leave" (the need-you list) the card is told it
 * does not, and then it neither answers on Escape nor offers it as a key: a hint saying "esc Deny"
 * above a key that folds the card away would be a lie about the one key that matters.
 */
describe("a pending request's Escape", () => {
  for (const p of [bash, question, plan]) {
    it(`answers the ${p.toolName} card where the card owns it`, () => {
      const onDecide = vi.fn();
      render(<PendingRequest permission={p} onDecide={onDecide} />);
      fireEvent.keyDown(screen.getByRole("group", { name: groupOf(p) }), { key: "Escape" });
      expect(onDecide).toHaveBeenCalledWith("deny");
    });

    it(`leaves the ${p.toolName} card unanswered where the surface owns it, and lets the key go on`, () => {
      // THE MUTANT: ignore `ownsEscape` in the card. Leaving the page would deny the request.
      const onDecide = vi.fn();
      const leave = vi.fn();
      render(<div onKeyDown={(e) => { if (e.key === "Escape") leave(); }}>
        <PendingRequest permission={p} onDecide={onDecide} ownsEscape={false} />
      </div>);
      fireEvent.keyDown(screen.getByRole("group", { name: groupOf(p) }), { key: "Escape" });
      expect(onDecide).not.toHaveBeenCalled();
      expect(leave).toHaveBeenCalled();
    });
  }

  it("offers esc as a key only on a card that owns it", () => {
    // THE MUTANT: keep the hint when the card does not own the key.
    const { unmount } = render(<PendingRequest permission={bash} onDecide={() => {}} />);
    expect(screen.getByText("esc")).toBeTruthy();
    unmount();
    render(<PendingRequest permission={bash} onDecide={() => {}} ownsEscape={false} />);
    expect(screen.queryByText("esc")).toBeNull();
  });

  it("drops a question's esc Skip where the surface owns the key", () => {
    const { unmount } = render(<PendingRequest permission={question} onDecide={() => {}} />);
    expect(screen.getByText("esc")).toBeTruthy();
    unmount();
    render(<PendingRequest permission={question} onDecide={() => {}} ownsEscape={false} />);
    expect(screen.queryByText("esc")).toBeNull();
  });
});
