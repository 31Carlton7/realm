import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { backgroundTaskFrom } from "./background-task";
import { createSdkMapper } from "./map-sdk-message";

/**
 * The fixture is a real capture, not a hand-written approximation: one background agent launched
 * against Claude Code 2.1.258, running `sleep 12` inside itself, from launch to completion. Every
 * message the harness emitted about its tasks in that run is here, in order.
 *
 * It exists because the first version of this code was written against the wrong surface. The
 * session's stored JSONL shows the completion as `<task-notification>` prose in a user turn, which
 * looks authoritative and is not what crosses the wire — the wire carries structured `system`
 * messages, and a parser built for the prose emitted nothing at all in a live run. Anything claimed
 * about this protocol has to be provable from a capture.
 */
const here = dirname(fileURLToPath(import.meta.url));
const LIVE = JSON.parse(readFileSync(join(here, "fixtures", "background-tasks.json"), "utf8")) as unknown[];

const at = (subtype: string, i = 0) => LIVE.filter((m) => (m as { subtype: string }).subtype === subtype)[i]!;

/**
 * One workflow run, captured the same way (Claude Code 2.1.281): the `Workflow` call, its launch
 * receipt, the turn that ends while the run is still working, the run's end, and the turn Claude
 * Code then starts by itself to report. What it settles that the agent capture could not: a
 * workflow's start carries no `is_backgrounded` at all, so a parser that waits for that field never
 * marks one, and the call reads as finished for the whole of the run.
 */
const WORKFLOW = JSON.parse(readFileSync(join(here, "fixtures", "workflow-run.json"), "utf8")) as unknown[];

const wf = (subtype: string, i = 0) => WORKFLOW.filter((m) => (m as { subtype?: string }).subtype === subtype)[i]!;

describe("backgroundTaskFrom", () => {
  it("reads a backgrounded agent's start off the live capture", () => {
    expect(backgroundTaskFrom(at("task_started"))).toEqual({
      toolUseId: "toolu_01Fb1nhsQsro42fKpn1NAdHR", status: "running", taskId: "afdbbdc3dc8394a04",
    });
  });

  it("reads its stop, with the harness's own summary", () => {
    expect(backgroundTaskFrom(at("task_notification", 1))).toEqual({
      toolUseId: "toolu_01Fb1nhsQsro42fKpn1NAdHR", status: "stopped", summary: "done", outcome: "completed", taskId: "afdbbdc3dc8394a04",
    });
  });

  it("ignores the shell command the sub-agent ran INSIDE itself", () => {
    // THE MUTANT: accept any task_started. This one is `local_bash`, `is_backgrounded: false` and
    // `owned_by_subagent` — a `sleep` the agent ran, not an agent. Counting it turns one running
    // agent into two rows, one of which names a shell command.
    expect(backgroundTaskFrom(at("task_started", 1))).toBeNull();
  });

  it("says nothing about progress, updates, or the changed-set snapshot", () => {
    // `task_progress` would re-mark a run that is already marked. `task_updated` and
    // `background_tasks_changed` carry no tool_use_id at all, so there is nothing to attribute them
    // to — reading them would mean guessing which call they meant.
    for (const subtype of ["task_progress", "task_updated", "background_tasks_changed"]) {
      expect(backgroundTaskFrom(at(subtype)), subtype).toBeNull();
    }
  });

  it("ignores anything that is not a system message, or that names no call", () => {
    expect(backgroundTaskFrom({ type: "assistant", subtype: "task_started", tool_use_id: "t1" })).toBeNull();
    expect(backgroundTaskFrom({ type: "system", subtype: "task_notification" })).toBeNull();
    expect(backgroundTaskFrom(null)).toBeNull();
  });

  it("still ignores a blocking sub-agent, whose call stays open by itself", () => {
    expect(backgroundTaskFrom({ ...(at("task_started") as object), is_backgrounded: false })).toBeNull();
  });
});

describe("backgroundTaskFrom, on a workflow's run", () => {
  it("reads a workflow's start off the capture, though it carries no is_backgrounded", () => {
    expect(wf("task_started")).not.toHaveProperty("is_backgrounded");
    expect(backgroundTaskFrom(wf("task_started"))).toEqual({ toolUseId: "toolu_fake_2", status: "running", taskId: "w1m36gxx5" });
  });

  it("reads a workflow's stop with the harness's summary and how the run ended", () => {
    expect(backgroundTaskFrom(wf("task_notification"))).toEqual({
      toolUseId: "toolu_fake_2", status: "stopped", summary: 'Dynamic workflow "Probe run with two agents" completed', outcome: "completed", taskId: "w1m36gxx5",
    });
  });

  it("ignores a workflow that a sub-agent started, as it ignores anything else one starts", () => {
    expect(backgroundTaskFrom({ ...(wf("task_started") as object), owned_by_subagent: true })).toBeNull();
  });

  it("says nothing of a workflow's progress, its update, or the changed-set snapshot", () => {
    for (const subtype of ["task_progress", "task_updated", "background_tasks_changed"]) {
      expect(backgroundTaskFrom(wf(subtype)), subtype).toBeNull();
    }
  });

  it.each(["stopped", "failed"] as const)("keeps the harness's own word for a run that %s", (status) => {
    expect(backgroundTaskFrom({ ...(wf("task_notification") as object), status })).toMatchObject({ status: "stopped", outcome: status });
  });

  it("leaves a way of ending it does not know unstated, rather than reading it as one of the three", () => {
    expect(backgroundTaskFrom({ ...(wf("task_notification") as object), status: "killed" })).not.toHaveProperty("outcome");
  });

  it("carries no task id for a message that names none", () => {
    expect(backgroundTaskFrom({ ...(wf("task_started") as object), task_id: 7 })).toEqual({ toolUseId: "toolu_fake_2", status: "running" });
  });
});

describe("the mapper over the whole live capture", () => {
  it("emits exactly one running and one stopped event, for the one agent that ran", () => {
    const m = createSdkMapper();
    const out = LIVE.flatMap((msg) => m.map(msg as never));
    // THE MUTANT: any loosening of the three start conditions shows up here as a third event —
    // the nested bash task's start, its notification, or a progress tick marking the same run again.
    expect(out.map((e) => (e.type === "background_task" ? `${e.payload.status}:${e.payload.toolUseId}` : e.type))).toEqual([
      "running:toolu_01Fb1nhsQsro42fKpn1NAdHR",
      "stopped:toolu_01FN9wFwCG8JCtBRYqpWjvZu",
      "stopped:toolu_01Fb1nhsQsro42fKpn1NAdHR",
    ]);
  });

  /* The middle one is the nested bash task's notification, and it is emitted on purpose rather than
     filtered here: it names a real tool_use_id and the transcript fold is where it is discarded,
     against a block that was never marked running. Asserting it stays visible at this layer keeps
     that division honest — if it were filtered here too, the fold's guard would be untested and
     would rot. `transcript-model` owns the other half of this test. */
});

describe("the mapper over the whole workflow capture", () => {
  it("emits one running and one stopped event for the run without the harness's task id on either", () => {
    const m = createSdkMapper();
    const out = WORKFLOW.flatMap((msg) => m.map(msg as never));
    expect(out.flatMap((e) => (e.type === "background_task" ? [e.payload] : []))).toEqual([
      { toolUseId: "toolu_fake_2", status: "running" },
      { toolUseId: "toolu_fake_2", status: "stopped", summary: 'Dynamic workflow "Probe run with two agents" completed', outcome: "completed" },
    ]);
  });

  it("knows the run's task id by its launching call from the start until the stop", () => {
    const m = createSdkMapper();
    const seen: (string | undefined)[] = [];
    for (const msg of [wf("background_tasks_changed"), wf("task_started"), wf("task_progress"), wf("task_notification")]) {
      m.map(msg as never);
      seen.push(m.taskIdOf("toolu_fake_2"));
    }
    expect(seen).toEqual([undefined, "w1m36gxx5", "w1m36gxx5", undefined]);
  });

  it("knows no task id for the shell command a sub-agent ran, which is a task and not a run", () => {
    const m = createSdkMapper();
    for (const msg of LIVE.slice(0, 4)) m.map(msg as never);
    expect(m.taskIdOf("toolu_01Fb1nhsQsro42fKpn1NAdHR")).toBe("afdbbdc3dc8394a04");
    expect(m.taskIdOf("toolu_01FN9wFwCG8JCtBRYqpWjvZu")).toBeUndefined();
  });
});
