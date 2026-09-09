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

describe("backgroundTaskFrom", () => {
  it("reads a backgrounded agent's start off the live capture", () => {
    expect(backgroundTaskFrom(at("task_started"))).toEqual({
      toolUseId: "toolu_01Fb1nhsQsro42fKpn1NAdHR", status: "running",
    });
  });

  it("reads its stop, with the harness's own summary", () => {
    expect(backgroundTaskFrom(at("task_notification", 1))).toEqual({
      toolUseId: "toolu_01Fb1nhsQsro42fKpn1NAdHR", status: "stopped", summary: "done",
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
