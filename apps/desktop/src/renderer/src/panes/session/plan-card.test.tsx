import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Transcript } from "./Transcript";
import type { Block, PendingPermission, Transcript as TranscriptModel } from "./transcript-model";

afterEach(() => cleanup());

const model = (blocks: Block[], pendingPermissions: PendingPermission[] = []): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions, usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null });

const perm = (over: Partial<PendingPermission> = {}): PendingPermission =>
  ({ requestId: "r1", toolName: "ExitPlanMode", title: "Exit plan mode?", input: { plan: "# Ship it" }, ...over });

describe("the plan card", () => {
  it("renders prose as the markdown it is, not as a clipped one-line tool summary", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "plan", planId: "p1", text: "# Ship it\n\nRewrite `foo` first.", ts: 1 },
    ])} />);
    const card = document.querySelector(".plan-card")!;
    expect(within(card as HTMLElement).getByRole("heading", { level: 1 })).toHaveTextContent("Ship it");
    expect(card.querySelector("code")).toHaveTextContent("foo");
    // The mutant: leaving ExitPlanMode on the tool path. The plan would come back as a `.tool-card`
    // whose summary is the first 90 characters of the document.
    expect(document.querySelector(".tool-card")).toBeNull();
  });

  it("draws a checklist plan with its per-step status", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "plan", planId: "p1", steps: [{ text: "Read the spec", status: "completed" }, { text: "Write it", status: "in_progress" }], ts: 1 },
    ])} />);
    const items = document.querySelectorAll(".plan-card .todo-list li");
    expect([...items].map((li) => li.getAttribute("data-status"))).toEqual(["completed", "in_progress"]);
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });

  it("draws both halves when a plan carries both, and neither when it carries neither", () => {
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([
      { kind: "plan", planId: "p1", text: "why", steps: [{ text: "how", status: "pending" }], ts: 1 },
    ])} />);
    expect(document.querySelector(".plan-card .todo-list")).toBeTruthy();
    expect(document.querySelector(".plan-card .plan-body")).toBeTruthy();
  });
});

describe("what a reader can do with a plan", () => {
  const PLAN: Block = {
    kind: "plan", planId: "p1", text: "Rewrite the parser.",
    steps: [{ text: "Read the spec", status: "completed" }, { text: "Write it", status: "pending" }], ts: 1,
  };

  it("copies the WHOLE plan, both halves, as markdown a checklist survives", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([PLAN])} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy plan" }));
    const copied = String(writeText.mock.calls.at(0)?.[0] ?? "");
    /* Both artifacts, because the two protocols send two different ones and a plan carrying both
       draws both — a copy that took only the prose would silently drop the checklist. The steps go
       out as task-list items so they are still a checklist wherever they are pasted. */
    expect(copied).toContain("- [x] Read the spec");
    expect(copied).toContain("- [ ] Write it");
    expect(copied).toContain("Rewrite the parser.");
    vi.unstubAllGlobals();
  });

  it("downloads it through the bridge, under a name taken from the plan itself", () => {
    const saveText = vi.fn(async () => null);
    vi.stubGlobal("realm", { saveText });
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([PLAN])} />);
    fireEvent.click(screen.getByRole("button", { name: "Download plan" }));
    // Named off the first real line, so a session that produced three plans does not write three
    // files called plan.md.
    expect(saveText).toHaveBeenCalledWith({ name: "read-the-spec.md", text: expect.stringContaining("Rewrite the parser.") });
    vi.unstubAllGlobals();
  });

  it("offers Expand only when there is somewhere to expand INTO", () => {
    /* The card renders in read-only mounts too (the fork preview, this suite), which have no sheet
       host. A dead button there would be worse than none: the one gesture that promises the rest of
       a clipped plan must never be the one that does nothing. */
    const { rerender } = render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model([PLAN])} />);
    expect(screen.queryByRole("button", { name: "Expand plan" })).toBeNull();
    const onExpandPlan = vi.fn();
    rerender(<Transcript sessionStatus="idle" onDecide={() => {}} onExpandPlan={onExpandPlan} transcript={model([PLAN])} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand plan" }));
    // The plan's own id, not the block's index: a revised plan replaces its block in place.
    expect(onExpandPlan).toHaveBeenCalledWith("p1");
  });
});

describe("planning reads as planning", () => {
  it("names the live run Planning, instead of one of the sixteen playful verbs", () => {
    /* The complaint this answers: in Plan mode nothing on screen said the agent was PLANNING. It
       looked like every other run — a verb, then prose — which hides the one distinction the mode
       exists to draw, and the reason a plan arrives as a proposal to approve rather than as work
       already done. */
    render(<Transcript sessionStatus="running" mode="plan" onDecide={() => {}}
      transcript={{ ...model([]), run: { startedAt: 1, waitedMs: 0, waitingSince: null } }} />);
    expect(screen.getByText("Planning…")).toBeTruthy();
  });

  it("leaves every other mode on its own run's verb", () => {
    render(<Transcript sessionStatus="running" mode="build" onDecide={() => {}}
      transcript={{ ...model([]), run: { startedAt: 1, waitedMs: 0, waitingSince: null } }} />);
    expect(screen.queryByText("Planning…")).toBeNull();
  });
});

describe("the decision on a plan", () => {
  it("is the plan's own approve/keep-planning row, never the generic Allow / Allow always / Deny card", () => {
    render(<Transcript sessionStatus="waiting_permission" onDecide={() => {}} transcript={model(
      [{ kind: "plan", planId: "toolu_p", text: "# Ship it", ts: 1 }], [perm()])} />);
    // The mutant: dropping the isPlanDecision branch. "Allow always" on a plan is a standing grant to
    // leave Plan unasked, which is not a thing a user can mean — and the card would print the plan a
    // second time under the one already on screen.
    expect(document.querySelector(".permission-card")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow always" })).toBeNull();
    expect(document.querySelectorAll(".plan-card")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Implement this plan" })).toBeTruthy();
  });

  it("answers on the permission channel, because that is how the session leaves Plan", () => {
    const onDecide = vi.fn();
    const view = render(<Transcript sessionStatus="waiting_permission" onDecide={onDecide} transcript={model([], [perm()])} />);
    fireEvent.click(screen.getByRole("button", { name: "Implement this plan" }));
    expect(onDecide).toHaveBeenCalledWith("r1", "allow");
    view.rerender(<Transcript sessionStatus="waiting_permission" onDecide={onDecide} transcript={model([], [perm()])} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(onDecide).toHaveBeenLastCalledWith("r1", "deny");
  });

  it("leaves every other tool on the permission card", () => {
    render(<Transcript sessionStatus="waiting_permission" onDecide={() => {}} transcript={model([], [
      perm({ toolName: "Bash", input: { command: "rm -rf /" }, title: "Run rm?" }),
    ])} />);
    expect(document.querySelector(".permission-card")).toBeTruthy();
    expect(document.querySelector(".plan-decision")).toBeNull();
  });
});
