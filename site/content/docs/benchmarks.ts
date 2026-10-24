import { code, h2, h3, note, p, page, steps, table, ul } from "@/lib/docs-blocks"

// Every number here was recomputed from the author's logs. The x86_64 runner's: the linux-bench-runs artifact of
// https://github.com/31Carlton7/realm/actions/runs/40114216116, measured from the published v2.5.0 release (repeat/{realm,orca}-run{1,2,3}.json and -res*.csv,
// F-{realm,orca}/serve-ready.json, result-crash.json and merge.json, E-gui-*/probe.json, out/environment.txt). The
// M4 Pro's: realm-worktrees/.verify/oct23/bench/runs (repeat/, F-realm/, F-realm-macos/).
// Submitted to the benchmark in https://github.com/arjunkshah12345-hash/agent-orchestrator-bench/pull/1.
export default page({
  slug: "benchmarks",
  title: "Benchmarks",
  summary:
    "Realm's numbers on lane A of the public agent orchestrator benchmark: six tasks run at once, each in its own worktree, one crashed on purpose, then merged. Realm's author ran them, on GitHub's x86_64 Linux runner beside Orca, and on the author's own Mac.",
  body: [
    note(
      "Realm's author, Carlton Aikins, ran every test on this page, and nobody else has repeated them yet. The benchmark's own machine was an x86_64 Linux box with 8 vCPUs; the closest of these is GitHub's x86_64 runner, with 4, where Orca ran beside Realm with the same harness.",
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
    p("Beside lane A, the benchmark's launch probe opens each app's window on a virtual display and times its first window, its memory and whether it asks for an account."),

    h2("How Realm was driven"),
    p("Through the [command line](/docs/command-line), which was written for this and comes with Realm 2.5. For each run, the harness:"),
    steps(
      "Starts `realm serve` on a new, empty Realm home, with `REALM_ENABLE_FAKE_AGENT=1`. No agent signs in, and nothing reaches a model.",
      "Opens the task repository once, with `realm repo add`.",
      "Starts the six tasks together, one `realm run <repo> --worktree <task> -- <stub>` each.",
      "Records when `realm wait` reports that every command has ended, and how each one ended.",
      "Runs the benchmark's own verifiers 14 seconds after the launch, as its harness for Orca does, then stops the server.",
    ),
    p(
      "Each machine had three clean runs, a crash run and a run for the merge. The benchmark publishes its task repository without git history, so the harness gives its copy one commit, with a fixed date, before it starts.",
    ),

    h2("On GitHub's x86_64 runner, beside Orca"),
    p(
      "Realm, from its published v2.5.0 AppImage (checked against the release's sha256), and Orca 1.4.230, on one runner in one job, three runs each. Times are seconds from the first launch, and the mean wall is the time from launch to verified. Peak memory is the most that the server, the six stubs and their shells held at once, sampled every second.",
    ),
    table(
      ["Measured", "Realm", "Orca 1.4.230"],
      ["Verified", "18/18", "18/18"],
      ["All six launched (s)", "0.51–0.57", "2.58–2.67"],
      ["Mean wall (s)", "15.5", "17.6"],
      ["Peak memory (MB)", "342–345", "1,227–1,347"],
      ["Server ready (s)", "0.51–0.52", "3.24–3.34"],
      ["Server at rest (MB)", "163–165", "385–412"],
      ["First window, median of 3 (s)", "3.32", "4.10"],
      ["The app's processes, 12 s later (MB)", "968", "922"],
      ["Account wall", "None", "None"],
    ),
    ul(
      "**The crash.** For both, the other five verified and the refactor task's partial file stayed in its worktree. Realm reported that task as killed by signal 9, so `realm wait` exited with 1.",
      "**The merge.** For both, five branches merged cleanly and `t5b` conflicted in `shelf/config.py`, as designed.",
      "**The launch probe.** Each app opened three times after a warm-up that wasn't counted, the two taking turns, with a clean home folder each time.",
    ),
    p(
      "Realm ran headless from its packaged command, `squashfs-root/resources/bin/realm`, with no display; Orca ran its own `orca-ide` on a virtual display, as the benchmark runs it. The wall time is the launch, then the 14 seconds the benchmark waits before verifying, then the verifiers themselves: the wait is the same for every tool, and the launch is the part that's the orchestrator's.",
    ),

    h3("On an M4 Pro Mac"),
    p("The same lane on the author's MacBook Pro, Realm only, in a Linux container and on macOS itself:"),
    table(
      ["Ran on", "Runs", "All six launched (s)", "Mean wall (s)", "Verified", "Peak memory (MB)"],
      ["Linux container, M4 Pro", "3", "0.20–0.23", "14.8", "18/18", "247–250"],
      ["macOS, M4 Pro", "3", "0.14–0.24", "15.1", "18/18", "280–313"],
    ),
    p(
      "There the server was ready in 0.39–0.56 s in the container and 0.29–0.42 s on macOS, and held 150 MB and 110–149 MB at rest. The crash and the merge came out as on the runner, on both.",
    ),

    h2("The machines"),
    table(
      ["", "GitHub's runner", "M4 Pro, Linux container", "M4 Pro, macOS"],
      ["System", "Ubuntu 24.04.5, x86_64, on GitHub's ubuntu-latest", "Debian 13 (trixie), in Docker Desktop's Linux VM: aarch64", "macOS 27.2"],
      ["Processor and memory", "4 vCPUs (AMD EPYC 7763), 16 GB", "14 CPUs and 7.65 GB given to the VM, on an Apple M4 Pro with 24 GB", "Apple M4 Pro, 14 cores, 24 GB"],
      ["Realm", "The v2.5.0 release's AppImage", "Commit `119c67a1`, from source", "Commit `119c67a1`, from source"],
      ["Load", "Under 2 as Realm's runs began", "Otherwise idle, load under 1.5", "Busy: simulators and other work, load 10 to 160"],
    ),
    p(
      "On the runner, Realm is the published v2.5.0 release, downloaded and checked against its sha256; on the M4 Pro, commit `119c67a1`, Realm 2.4.0 with the command line added. Realm's whole app holds about 45 MB more than Orca's 12 s after launch; everything else measured favours Realm. No agent CLI was installed on the runner, so nothing there could reach a model. Its run is public: [run 40114216116](https://github.com/31Carlton7/realm/actions/runs/40114216116), from the [Linux bench workflow](https://github.com/31Carlton7/realm/blob/ci/linux-bench/.github/workflows/linux-bench.yml).",
    ),

    h2("What these numbers don't tell you"),
    ul(
      "How well any agent codes. The stub is a script, not a model, and no real agent ran.",
      "How Realm feels to use. The launch probe times the first window; lane A drives the headless server.",
      "Small differences. Three runs each is few, and the benchmark's own report treats differences under about 20% as noise.",
      "The benchmark's own machine. GitHub's runner has half its vCPUs, and the Mac is a different architecture altogether.",
      "What anyone else would measure. Until someone else runs them, these are one person's numbers, from the person who makes Realm.",
    ),

    h2("Run it yourself"),
    p(
      "You need Python 3 and git, and Realm 2.5 or later. On Linux, extract the AppImage from the [latest release](https://github.com/31Carlton7/realm/releases/latest), then, in a clone of the benchmark with Realm's harness in it, run the whole suite with the packaged command:",
    ),
    code(
      `./Realm-*.AppImage --appimage-extract
git clone https://github.com/arjunkshah12345-hash/agent-orchestrator-bench.git
cd agent-orchestrator-bench
REALM_BIN=/path/to/squashfs-root/resources/bin/realm python3 harness/realm_suite.py`,
      "Terminal",
    ),
    p(
      "`REALM_BIN` takes any `realm` command, such as the Mac app's (see [Command line](/docs/command-line#install)). A source build works too: set `REALM_JS` to its `apps/server/dist/realm.js` instead, and `REALM_NODE` to the Node it should run on.",
    ),
    note(
      "Realm's harness and the logs behind this page are submitted to the benchmark in [pull request #1](https://github.com/arjunkshah12345-hash/agent-orchestrator-bench/pull/1), by Realm's author, with that conflict of interest stated. Until it's merged, the harness is also in Realm's repository, in [bench/ on the ci/linux-bench branch](https://github.com/31Carlton7/realm/tree/ci/linux-bench/bench).",
    ),
    p(
      "The suite writes where the benchmark keeps its own results: `realm-run1.json` to `realm-run3.json` in `runs/repeat/`, each with a memory sample beside it, and `runs/F-realm/` for the crash, the merge and the server's start times. `REALM_PORT` sets the server's port, 8796 unless you set it. The benchmark's [REPRODUCE.md](https://github.com/arjunkshah12345-hash/agent-orchestrator-bench/blob/main/REPRODUCE.md) covers the tools it tested itself.",
    ),
  ],
})
