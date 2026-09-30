import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type LayaRuntimeState, type LayaStatus } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";
import { LayaSection } from "./LayaSection";
import { SettingsPage } from "./SettingsPage";

/**
 * Settings ▸ Engines ▸ Laya, one state at a time. What must die: a state line that says anything but
 * the server's state, an Install offered where it cannot run or where it would run twice, Shadow
 * offered before an install, a failure reworded, a download meter with no denominator, and a log
 * deleted by one stray click.
 */

afterEach(() => cleanup());

const status = (runtime: LayaRuntimeState, over: Partial<LayaStatus> = {}): LayaStatus => ({
  mode: "off", installed: false, runtime, stepsLogged: 0, dir: "/Users/u/Realm/laya", assist: { available: false, reason: "No checkpoint has been evaluated yet. Train Laya on this Mac first; Assist unlocks when one scores 95% on held-out steps.", threshold: null, accuracy: null }, ...over,
});

async function mount(laya: LayaStatus, over: { confirmDelete?: boolean } = {}) {
  const api = fakeApi({ laya });
  const store = createAppStore(api);
  await store.getState().boot();
  if (over.confirmDelete === false) store.setState({ confirmDelete: false });
  render(<StoreContext.Provider value={store}><LayaSection /></StoreContext.Provider>);
  await waitFor(() => expect(store.getState().laya).not.toBeNull());
  return { api, store, stateRow: () => screen.getByRole("listitem", { name: /^Laya: / }) };
}

const modeControl = () => screen.getByRole("group", { name: "Laya" });

describe("the Laya section", () => {
  it("sits in Settings ▸ Engines under its own heading", async () => {
    const api = fakeApi({});
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><SettingsPage item={item("set", "s1", { kind: "settings-page", refId: PAGE_REF_IDS["settings-page"] })} visible /></StoreContext.Provider>);
    expect(await screen.findByRole("heading", { name: "Laya (local decisions)" })).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toContain("layaStatus"));
  });

  it("says nothing until it has read the status", async () => {
    const api = fakeApi({});
    const store = createAppStore(api);
    render(<StoreContext.Provider value={store}><LayaSection /></StoreContext.Provider>);
    expect(screen.getByText("Checking…")).toBeInTheDocument();
  });

  it("not installed: says what Install will download and where, and offers it", async () => {
    const { api, stateRow } = await mount(status({ state: "not-installed", python: { path: "/opt/homebrew/bin/python3.13", version: "3.13.12" } }));
    expect(stateRow()).toHaveAccessibleName("Laya: Not installed");
    expect(within(stateRow()).getByText("Downloads about 1 GB of PyTorch and 0.8 GB of model weights into /Users/u/Realm/laya, with Python 3.13.12.")).toBeInTheDocument();
    // Shadow before an install is refused by the server; the control does not offer it.
    expect(modeControl()).toBeDisabled();
    fireEvent.click(within(stateRow()).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(api.calls).toContain("layaInstall"));
    // The answer is what renders next: installing, with no second Install to double-click.
    expect(await within(stateRow()).findByText("Creating a Python 3.13.12 environment")).toBeInTheDocument();
    expect(within(stateRow()).queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("needs Python: names what it turned down and why, offers the command that fixes it, and looks again", async () => {
    const { api, stateRow } = await mount(status({ state: "needs-python", rejected: [{ path: "/usr/local/bin/python3.12", why: "Python 3.12.8 for x86_64, which runs under Rosetta; PyTorch needs a native arm64 build" }] }));
    expect(stateRow()).toHaveAccessibleName("Laya: Needs Python");
    expect(within(stateRow()).getByText(/Turned down: \/usr\/local\/bin\/python3\.12 \(Python 3\.12\.8 for x86_64, which runs under Rosetta/)).toBeInTheDocument();
    expect(within(stateRow()).getByText("brew install python@3.13")).toBeInTheDocument();
    expect(within(stateRow()).queryByRole("button", { name: "Install" })).toBeNull();
    const reads = api.calls.filter((c) => c === "layaStatus").length;
    fireEvent.click(within(stateRow()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(api.calls.filter((c) => c === "layaStatus").length).toBe(reads + 1));
  });

  it("installing: narrates the step, and draws a meter only for the checkpoint, which has a size", async () => {
    const packages = await mount(status({ state: "installing", step: "packages", detail: "Downloading torch-2.14.0-cp313-cp313-macosx_14_0_arm64.whl (78.9 MB)", fraction: null }));
    expect(within(packages.stateRow()).getByText("Downloading torch-2.14.0-cp313-cp313-macosx_14_0_arm64.whl (78.9 MB)")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    cleanup();
    await mount(status({ state: "installing", step: "model", detail: "Downloading the checkpoint", fraction: 0.37 }));
    expect(screen.getByText("Downloading the checkpoint: 313 of 846 MB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Checkpoint download" })).toHaveAttribute("aria-valuenow", "37");
  });

  it("installed and off: Shadow is offered, and choosing it is a request the server answers", async () => {
    const { api, stateRow } = await mount(status({ state: "off" }, { installed: true }));
    expect(stateRow()).toHaveAccessibleName("Laya: Installed, not running");
    expect(within(modeControl()).getByRole("radio", { name: "Off" })).toBeChecked();
    fireEvent.click(within(modeControl()).getByRole("radio", { name: "Shadow" }));
    await waitFor(() => expect(api.calls).toContain("layaSetMode:shadow"));
    // What renders is the server's answer — starting — not the switch's own position.
    await waitFor(() => expect(stateRow()).toHaveAccessibleName("Laya: Starting"));
  });

  it("running: shows the device, the p50 and the checkpoint", async () => {
    const { stateRow } = await mount(status({ state: "ready", device: "mps", p50Ms: 35, checkpoint: "english@55cf4c4" }, { installed: true, mode: "shadow" }));
    expect(stateRow()).toHaveAccessibleName("Laya: Running");
    expect(within(stateRow()).getByText("mps")).toBeInTheDocument();
    expect(within(stateRow()).getByText(/p50 35 ms/)).toBeInTheDocument();
    expect(within(stateRow()).getByText("english@55cf4c4")).toBeInTheDocument();
  });

  it("running with nothing asked yet says so, rather than a latency it has not measured", async () => {
    const { stateRow } = await mount(status({ state: "ready", device: "cpu", p50Ms: null, checkpoint: "english@55cf4c4" }, { installed: true, mode: "shadow" }));
    expect(within(stateRow()).getByText(/no steps asked yet/)).toBeInTheDocument();
    expect(within(stateRow()).getByText("cpu")).toBeInTheDocument();
  });

  it("a failed install shows the installer's own words, its output, and Install again", async () => {
    const { api, stateRow } = await mount(status({ state: "failed", during: "install", reason: "ERROR: No matching distribution found for laya[serve]==0.3.21", detail: "Collecting laya[serve]==0.3.21\nERROR: No matching distribution found for laya[serve]==0.3.21\n" }));
    expect(stateRow()).toHaveAccessibleName("Laya: Install failed");
    expect(within(stateRow()).getByText("ERROR: No matching distribution found for laya[serve]==0.3.21")).toBeInTheDocument();
    expect(within(stateRow()).getByText(/^Collecting laya\[serve\]==0\.3\.21/)).toBeInTheDocument();
    fireEvent.click(within(stateRow()).getByRole("button", { name: "Install again" }));
    await waitFor(() => expect(api.calls).toContain("layaInstall"));
  });

  it("a start that kept failing says what the process last said, and Try again asks for Shadow again", async () => {
    const reason = "OSError: We couldn't connect to 'https://huggingface.co' to load the files, and couldn't find them in the cached files.";
    const { api, stateRow } = await mount(status({ state: "failed", during: "start", reason, detail: `Traceback (most recent call last):\n${reason}\n` }, { installed: true, mode: "shadow" }));
    expect(stateRow()).toHaveAccessibleName("Laya: Stopped after failing to start");
    expect(within(stateRow()).getByText(reason)).toBeInTheDocument();
    fireEvent.click(within(stateRow()).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.calls).toContain("layaSetMode:shadow"));
  });

  it("unavailable: the reason, and nothing to click", async () => {
    const { stateRow } = await mount(status({ state: "unavailable", reason: "Laya runs on Apple silicon only: PyTorch publishes no build for Intel Macs." }));
    expect(stateRow()).toHaveAccessibleName("Laya: Not available");
    expect(within(stateRow()).getByText(/Apple silicon only/)).toBeInTheDocument();
    expect(within(stateRow()).queryByRole("button")).toBeNull();
    expect(modeControl()).toBeDisabled();
  });

  it("follows the server's broadcasts while it is open", async () => {
    const { store, stateRow } = await mount(status({ state: "starting" }, { installed: true, mode: "shadow" }));
    store.getState().applyLaya(status({ state: "ready", device: "mps", p50Ms: 41, checkpoint: "english@55cf4c4" }, { installed: true, mode: "shadow", stepsLogged: 3 }));
    await waitFor(() => expect(stateRow()).toHaveAccessibleName("Laya: Running"));
    expect(screen.getByText("3 steps logged")).toBeInTheDocument();
  });
});

describe("the decision log row", () => {
  it("counts the steps, and deletes them only on a second, named click", async () => {
    const { api } = await mount(status({ state: "off" }, { installed: true, stepsLogged: 1234 }));
    expect(screen.getByText("1,234 steps logged")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete log" }));
    expect(api.calls).not.toContain("layaDeleteLog");
    fireEvent.click(screen.getByRole("button", { name: "Delete 1,234 steps" }));
    await waitFor(() => expect(api.calls).toContain("layaDeleteLog"));
    expect(await screen.findByText("No steps logged")).toBeInTheDocument();
  });

  it("deletes on one click for someone who turned the question off", async () => {
    const { api } = await mount(status({ state: "off" }, { installed: true, stepsLogged: 2 }), { confirmDelete: false });
    fireEvent.click(screen.getByRole("button", { name: "Delete log" }));
    await waitFor(() => expect(api.calls).toContain("layaDeleteLog"));
  });

  it("has nothing to delete when nothing was logged", async () => {
    await mount(status({ state: "off" }, { installed: true }));
    expect(screen.getByRole("button", { name: "Delete log" })).toBeDisabled();
  });

  it("says what the log and the recordings hold, where they are, and that they never leave this Mac", async () => {
    await mount(status({ state: "off" }, { installed: true }));
    expect(screen.getByText("The log and the recordings hold the names of what was on screen; a recording keeps no text anyone typed and no long text. Both are kept in /Users/u/Realm/laya and never leave this Mac.")).toBeInTheDocument();
  });
});

describe("the recordings row", () => {
  const row = () => screen.getByText("Recordings").closest("li")!;
  const recording = { id: "rec-1", simulatorId: "sim-1", device: "Test iPhone", apps: ["Instagram"], seen: ["Instagram"], screens: 12, startedAt: "2026-09-29T07:12:00.000Z", endedAt: null, lastError: null };

  it("says where a recording is started when there is none — the device pane — and has nothing to delete", async () => {
    await mount(status({ state: "off" }, { installed: true, recorded: { recordings: 0, screens: 0, apps: [] } }));
    expect(within(row()).getByText("No screens recorded")).toBeInTheDocument();
    expect(within(row()).getByText(/open an app on a device, choose Record for Laya in its pane's bar/)).toBeInTheDocument();
    expect(within(row()).getByRole("button", { name: "Delete recordings" })).toBeDisabled();
  });

  it("shows the recording under way with its count and a Stop, and why it is not reading when it is not", async () => {
    const { api } = await mount(status({ state: "off" }, { installed: true, recording: { ...recording, lastError: "the phone is locked" }, recorded: { recordings: 0, screens: 0, apps: [] } }));
    expect(within(row()).getByText("Recording Instagram on Test iPhone · 12 screens kept")).toBeInTheDocument();
    expect(within(row()).getByText("Not reading the device: the phone is locked")).toBeInTheDocument();
    // THE MUTANT: Delete in place of Stop while it records. The only way to end it would lose it.
    expect(within(row()).queryByRole("button", { name: "Delete recordings" })).toBeNull();
    fireEvent.click(within(row()).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.calls).toContain("layaStopRecording"));
    expect(await within(row()).findByText("12 screens of Instagram")).toBeInTheDocument();
  });

  it("counts what was kept across recordings, and deletes it only on a second, named click", async () => {
    const { api } = await mount(status({ state: "off" }, { installed: true, recorded: { recordings: 3, screens: 1402, apps: ["Instagram", "TikTok"] } }));
    expect(within(row()).getByText("1,402 screens of Instagram, TikTok")).toBeInTheDocument();
    fireEvent.click(within(row()).getByRole("button", { name: "Delete recordings" }));
    expect(api.calls).not.toContain("layaDeleteRecordings");
    fireEvent.click(within(row()).getByRole("button", { name: "Delete 1,402 screens" }));
    await waitFor(() => expect(api.calls).toContain("layaDeleteRecordings"));
    expect(await within(row()).findByText("No screens recorded")).toBeInTheDocument();
  });
});

describe("the Assist option", () => {
  it("is shown locked, with the measurement that locks it, until a checkpoint earns it", async () => {
    await mount(status({ state: "off" }, { installed: true }));
    const assist = screen.getByRole("radio", { name: "Assist" });
    // THE MUTANT: leave it selectable. The server refuses it — but only after the click.
    expect(assist).toBeDisabled();
    expect(screen.getByText(/Train Laya on this Mac first; Assist unlocks when one scores 95%/)).toBeInTheDocument();
  });

  it("can be chosen once the active checkpoint has earned it", async () => {
    const { api } = await mount(status({ state: "ready", device: "mps", p50Ms: 40, checkpoint: "local:2026-09-29" }, {
      installed: true, mode: "shadow", assist: { available: true, reason: null, threshold: 0.82, accuracy: 0.96 },
    }));
    const assist = screen.getByRole("radio", { name: "Assist" });
    expect(assist).not.toBeDisabled();
    fireEvent.click(assist);
    await waitFor(() => expect(api.calls).toContain("layaSetMode:assist"));
  });
});

describe("the evaluation and Train", () => {
  const evaluation = { checkpoint: "english@55cf4c4", createdAt: "2026-09-29T07:00:00.000Z", benchmark: "2026-09-29.1", targetAccuracy: 0.42, targetNotCopying: 0.401, sensitiveRecall: 0.815, verifyAccuracy: 0.455 };
  const row = () => screen.getByText("Evaluation").closest("li")!;

  it("shows the active checkpoint's three numbers, and which checkpoint they are of", async () => {
    await mount(status({ state: "off" }, { installed: true, evaluation, training: { state: "idle" } }));
    expect(within(row()).getByText(/^Picks the right element 42% \(40% when the words differ from its label\) · flags 82% of sensitive steps · judges 46% of steps right ·/)).toBeInTheDocument();
    expect(within(row()).getByText("english@55cf4c4")).toBeInTheDocument();
  });

  it("says so when the active checkpoint has no evaluation", async () => {
    await mount(status({ state: "off" }, { installed: true, evaluation: null }));
    expect(within(row()).getByText("The active checkpoint has not been scored.")).toBeInTheDocument();
  });

  it("offers Train only once there is an install to train in", async () => {
    await mount(status({ state: "not-installed", python: { path: "/opt/homebrew/bin/python3.13", version: "3.13.12" } }));
    expect(within(row()).getByRole("button", { name: "Train" })).toBeDisabled();
  });

  it("Train starts a run, which shows what it is doing and offers Stop — and Stop ends it with nothing kept", async () => {
    const { api } = await mount(status({ state: "off" }, { installed: true, evaluation, training: { state: "idle" } }));
    fireEvent.click(within(row()).getByRole("button", { name: "Train" }));
    await waitFor(() => expect(api.calls).toContain("layaTrain"));
    expect(await within(row()).findByText("Writing the training set")).toBeInTheDocument();
    // No second Train to double-click while one runs.
    expect(within(row()).queryByRole("button", { name: "Train" })).toBeNull();
    fireEvent.click(within(row()).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.calls).toContain("layaCancelTraining"));
    expect(await within(row()).findByText("Training stopped. Nothing it made was kept.")).toBeInTheDocument();
  });

  it("draws a meter for a run only where it has a denominator", async () => {
    await mount(status({ state: "off" }, { installed: true, training: { state: "running", step: "training", detail: "Epoch 1, step 900 of 2264, about 20 min left", fraction: 0.4, startedAt: "2026-09-29T07:12:00.000Z" } }));
    expect(within(row()).getByText("Epoch 1, step 900 of 2264, about 20 min left")).toBeInTheDocument();
    expect(within(row()).getByRole("progressbar", { name: "Training" })).toHaveAttribute("aria-valuenow", "40");
    cleanup();
    await mount(status({ state: "off" }, { installed: true, training: { state: "running", step: "preparing", detail: "Writing the training set", fraction: null, startedAt: "2026-09-29T07:12:00.000Z" } }));
    expect(within(row()).queryByRole("progressbar")).toBeNull();
  });

  it("says which way a finished run went, and why", async () => {
    await mount(status({ state: "off" }, { installed: true, training: { state: "done", at: "2026-09-29T08:00:00.000Z", checkpoint: "local:2026-09-29T07-12", activated: true, reason: "It picks the right element 71% of the time on held-out steps, against 42%.", targetAccuracy: 0.71 } }));
    expect(within(row()).getByText("Now running local:2026-09-29T07-12. It picks the right element 71% of the time on held-out steps, against 42%.")).toBeInTheDocument();
    cleanup();
    await mount(status({ state: "off" }, { installed: true, training: { state: "done", at: "2026-09-29T08:00:00.000Z", checkpoint: "local:2026-09-29T07-12", activated: false, reason: "It picks the right element 40% of the time on held-out steps, and the active checkpoint 42%.", targetAccuracy: 0.4 } }));
    expect(within(row()).getByText("Kept the checkpoint Laya was running; local:2026-09-29T07-12 was discarded. It picks the right element 40% of the time on held-out steps, and the active checkpoint 42%.")).toBeInTheDocument();
  });

  it("gives a failed run in the trainer's own words, with its output", async () => {
    await mount(status({ state: "off" }, { installed: true, training: { state: "failed", at: "2026-09-29T08:00:00.000Z", reason: "RuntimeError: MPS backend out of memory", detail: "Traceback (most recent call last):\nRuntimeError: MPS backend out of memory" } }));
    expect(within(row()).getByText("Training failed: RuntimeError: MPS backend out of memory")).toBeInTheDocument();
    fireEvent.click(within(row()).getByText("Output"));
    expect(within(row()).getByText(/Traceback \(most recent call last\):/)).toBeInTheDocument();
  });
});
