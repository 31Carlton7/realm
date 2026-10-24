import { code, h2, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

// Every number here was recomputed from the author's logs in realm-worktrees/.verify/oct23/bench/runs: the
// Linux runs from repeat/realm-run{1,2,3}.json and realm-res{1,2,3}.csv, macOS from F-realm-macos/repeat/, the
// crash and merge from F-realm*/result-crash.json and merge.json, the machines from F-realm*/environment.txt.
// TODO(owner): fill the x86_64 GitHub-runner row once it's measured, and link the pull request that adds
// Realm's harness and these logs to the benchmark once it's open (strip your username from the logs first).
export default page({
  slug: "benchmarks",
  title: "Benchmarks",
  summary:
    "Realm's numbers on lane A of the public agent orchestrator benchmark: six tasks run at once, each in its own worktree, one crashed on purpose, then merged. Realm's author ran them, on his own Mac.",
  body: [
    note(
      "Realm's author, Carlton Aikins, ran these tests himself, on his own Mac, and nobody else has repeated them yet. The benchmark tested its other tools on a different machine, an x86_64 Linux box with 8 cores, so these numbers aren't a like-for-like comparison with its tables.",
    ),
    p(
      "The [agent orchestrator benchmark](https://github.com/arjunkshah12345-hash/agent-orchestrator-bench) compares apps that run several coding agents side by side. Its lane A measures the orchestrator, not a model: a stub agent, a short script that waits and then writes a known answer, stands in for every agent, so each run does the same work.",
    ),

    h2("What lane A measures"),
    ul(
      "**Six tasks at once.** A small repository with six tasks: a bug fix, a feature, a refactor, a set of tests, and two edits to the same file that conflict on purpose. The orchestrator starts all six together, each in a worktree of its own, and the stub takes 10 seconds to write each task's answer.",
      "**Hidden verifiers.** Fourteen seconds after the launch, a verifier checks each worktree. The harness records how long the six took to start, the time from launch to verified, and the peak memory of the orchestrator and the agents it started.",
      "**A crash.** In one run, the stub for the refactor task writes a partial file halfway through and kills itself with `SIGKILL`. The other five should still verify, and the partial work should stay where it was.",
      "**A merge.** Each worktree's changes are committed and merged into `main` in turn. Five should merge cleanly, and the sixth should conflict in `shelf/config.py`, as the tasks were written to.",
    ),

    h2("How Realm was driven"),
    p("Through the [command line](/docs/command-line), which was written for this and comes with the next release. For each run, the harness:"),
    steps(
      "Starts `realm serve` on a new, empty Realm home, with `REALM_ENABLE_FAKE_AGENT=1`. No agent signs in, and nothing reaches a model.",
      "Opens the task repository once, with `realm repo add`.",
      "Starts the six tasks together, one `realm run <repo> --worktree <task> -- <stub>` each.",
      "Records when `realm wait` reports that every command has ended, and how each one ended.",
      "Runs the benchmark's own verifiers 14 seconds after the launch, as its harness for Orca does, then stops the server.",
    ),
    p(
      "Each platform had three clean runs, a crash run, and a run for the merge. Realm was at commit `119c67a1`, which is Realm 2.4.0 with the command line added. The benchmark publishes its task repository without git history, so the harness gives its copy one commit, with a fixed date, before it starts.",
    ),

    h2("Results"),
    p(
      "Three runs on each platform, in the benchmark's own columns. Times are seconds from the first launch, and the mean wall is the time from launch to verified. Peak memory is the most that the server, the six stubs and their shells held at once, sampled every second.",
    ),
    table(
      ["Ran on", "Runs", "All six launched (s)", "Mean wall (s)", "Verified", "Peak memory (MB)"],
      ["Linux container, M4 Pro", "3", "0.20–0.23", "14.8", "18/18", "247–250"],
      ["macOS, M4 Pro", "3", "0.14–0.24", "15.1", "18/18", "280–313"],
      ["Linux x86_64, GitHub-hosted runner", "TODO", "TODO", "TODO", "TODO", "TODO"],
    ),
    p("And what those columns leave out:"),
    table(
      ["Measured", "Linux, in a container", "macOS"],
      ["The server ready, after it starts", "0.39–0.56 s", "0.29–0.42 s"],
      ["The server's memory at rest", "150 MB", "110–149 MB"],
      ["Every command ended, by `realm wait`", "10.32–10.35 s", "10.29–10.36 s"],
      ["The six verifiers, one after another", "0.59–0.64 s", "0.87–0.97 s"],
    ),
    ul(
      "**The crash.** On both platforms the other five verified, the refactor task's partial file stayed in its worktree, and Realm reported that task as killed by signal 9, so `realm wait` exited with 1.",
      "**The merge.** On both platforms five branches merged cleanly and `t5b` conflicted in `shelf/config.py`, as designed. The five merged tasks verified again afterwards.",
    ),
    p(
      "The wall time is the launch, then the 14 seconds the benchmark waits before verifying, then the verifiers themselves. The wait is the same for every tool it tests; the launch is the part that's Realm's. The benchmark's [report](https://github.com/arjunkshah12345-hash/agent-orchestrator-bench/blob/main/report.md) has the other tools' numbers, from its own machine.",
    ),

    h2("The machines"),
    p("Both ran on one MacBook Pro: an Apple M4 Pro with 14 cores and 24 GB of memory, on macOS 27.2."),
    table(
      ["", "Linux, in a container", "macOS"],
      ["System", "Debian 13 (trixie), in Docker Desktop's Linux VM: aarch64, given 14 CPUs and 7.65 GB", "macOS 27.2, directly"],
      ["Software", "Python 3.14.4, git 2.47.3, Node 22.23.2", "Python 3.14.6, git 2.51.2, Node 22.23.2"],
      ["Memory sampler", "The benchmark's own, `sampler.py`", "`sampler_ps.py`, the same columns read with `ps`, since macOS has no `/proc`"],
      ["Load", "Otherwise idle, with a load average under 1.5", "Busy: simulators and other work were running, with load averages from 10 to 160"],
    ),
    p(
      "The benchmark's own runs used Linux on x86_64 with 8 vCPUs and 16 GB. A different processor, architecture and number of cores can move every number above, which is what the x86_64 row is for.",
    ),

    h2("What these numbers don't tell you"),
    ul(
      "How well any agent codes. The stub is a script, not a model, and no real agent ran.",
      "Anything about Realm's window. These runs drive the headless server, and the Linux app hasn't been measured.",
      "Small differences. Three runs per platform is few, and the benchmark's own report treats differences under about 20% as noise.",
      "What anyone else would measure. Until someone else runs them, these are one person's numbers, from the person who makes Realm.",
    ),

    h2("Run it yourself"),
    p(
      "You need Python 3, git, Node.js 22.13 or newer and pnpm 10. First build Realm's server and its command line. Until the command line is released, it's on a branch:",
    ),
    code(
      `git clone --branch feat/orchestrator-bench https://github.com/31Carlton7/realm.git
cd realm
pnpm install --filter "@realm/server..."
pnpm --filter @realm/server build`,
      "Terminal",
    ),
    p("Then, in a clone of the benchmark with Realm's harness in it, run the whole suite, pointed at the command line you built:"),
    code(
      `git clone https://github.com/arjunkshah12345-hash/agent-orchestrator-bench.git
cd agent-orchestrator-bench
REALM_JS=/path/to/realm/apps/server/dist/realm.js python3 harness/realm_suite.py`,
      "Terminal",
    ),
    note(
      "Realm's harness, `harness/realm_run.py` and `harness/realm_suite.py`, and the logs behind this page aren't in the benchmark's repository yet. TODO: link the pull request that adds them, once it's open.",
    ),
    p(
      "The suite writes where the benchmark keeps its own results: `realm-run1.json` to `realm-run3.json` in `runs/repeat/`, each with a memory sample beside it, and `runs/F-realm/` for the crash, the merge and the server's start times. `REALM_NODE` picks the Node it runs on, and `REALM_PORT` the server's port, 8796 unless you set it. The benchmark's [REPRODUCE.md](https://github.com/arjunkshah12345-hash/agent-orchestrator-bench/blob/main/REPRODUCE.md) covers the tools it tested itself.",
    ),
  ],
})
