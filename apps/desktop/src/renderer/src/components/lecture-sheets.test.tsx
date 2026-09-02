import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item, space } from "../state/store.test-fakes";
import { NewLectureSheet, WrapUpLectureSheet } from "./LectureSheets";
import { PlynnImportSheet } from "./PlynnImportSheet";

async function mount(ui: React.ReactElement, over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi({ spaces: [space("s1", "p1", "EE 457")], items: { s1: [item("i-sess", "s1", { kind: "session", refId: "se1" })] }, ...over });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().selectSpace("s1");
  await store.getState().openItem("i-sess");
  render(<StoreContext.Provider value={store}>{ui}</StoreContext.Provider>);
  return { api, store };
}

describe("NewLectureSheet", () => {
  it("names the course, starts on submit with the typed topic, and closes", async () => {
    const { api, store } = await mount(<NewLectureSheet />);
    act(() => store.getState().openSheet({ kind: "new-lecture" }));
    expect(screen.getByText("EE 457")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Lecture topic"), { target: { value: "Caches" } });
    fireEvent.click(screen.getByRole("button", { name: "Start lecture" }));
    await waitFor(() => expect(api.calls).toContain("startLecture:s1:Caches"));
    await waitFor(() => expect(store.getState().sheet).toBeNull());
    expect(store.getState().groups!.groups.some((g) => g.name.startsWith("Caches · "))).toBe(true);
  });

  it("Enter submits the form", async () => {
    const { api } = await mount(<NewLectureSheet />);
    fireEvent.submit(screen.getByLabelText("Lecture topic").closest("form")!);
    await waitFor(() => expect(api.calls).toContain("startLecture:s1:"));
  });
});

describe("WrapUpLectureSheet", () => {
  it("lists lectures newest first with transcripts marked, and wraps the picked one", async () => {
    const lectures = [
      { path: "lectures/2026-09-02-caches.md", title: "Caches", date: "2026-09-02", hasTranscript: true, sizeBytes: 10 },
      { path: "lectures/2026-09-01-pipelining.md", title: "Pipelining", date: "2026-09-01", hasTranscript: false, sizeBytes: 10 },
    ];
    const { api, store } = await mount(<WrapUpLectureSheet />, { lectures: { s1: lectures } });
    act(() => store.getState().openSheet({ kind: "wrap-up-lecture" }));
    const rows = await screen.findAllByRole("button", { name: /Wrap up$/ });
    expect(rows.map((r) => r.textContent)).toEqual(["Caches2026-09-02 · transcriptWrap up", "Pipelining2026-09-01Wrap up"]);
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(api.sent).toHaveLength(1));
    expect(api.sent[0]!.text).toContain("`lectures/2026-09-02-caches.md`");
    await waitFor(() => expect(store.getState().sheet).toBeNull());
  });

  it("says so when there are no lectures yet", async () => {
    await mount(<WrapUpLectureSheet />);
    expect(await screen.findByText(/No lecture files yet/)).toBeInTheDocument();
  });
});

describe("PlynnImportSheet", () => {
  const meetings = [
    { file: "/m/2026-09-02 14.05 EE 457 lecture.md", title: "EE 457 lecture", startedAt: "2026-09-02T14:05", sizeBytes: 2048, imported: false },
    { file: "/m/2026-09-01 09.00 Standup.md", title: "Standup", startedAt: "2026-09-01T09:00", sizeBytes: 300, imported: true },
  ];

  it("explains an absent folder instead of showing an empty list", async () => {
    await mount(<PlynnImportSheet />, { plynn: { available: false, folder: "/Users/x/Library/Application Support/Plynn/Meetings", meetings: [] } });
    expect(await screen.findByText(/No recordings found/)).toBeInTheDocument();
    expect(screen.getByText("/Users/x/Library/Application Support/Plynn/Meetings")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import \d/ })).toBeNull();
  });

  it("pre-checks only the not-yet-imported recordings, imports the checked ones, and reports the paths", async () => {
    const { api, store } = await mount(<PlynnImportSheet />, { plynn: { available: true, folder: "/m", meetings: meetings.map((m) => ({ ...m })) } });
    act(() => store.getState().openSheet({ kind: "plynn-import" }));
    const lecture = await screen.findByLabelText("Import EE 457 lecture");
    const standup = screen.getByLabelText("Import Standup");
    expect(lecture).toBeChecked();
    expect(standup).not.toBeChecked();
    expect(screen.getByText(/2026-09-01 09:00 · 300 B · imported/)).toBeInTheDocument();
    expect(screen.getByText(/2026-09-02 14:05 · 2 KB/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import 1 recording" }));
    await waitFor(() => expect(api.calls).toContain("plynnImport:s1:1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Imported 1 recording");
    expect(screen.getByText("lectures/imported-2026-09-02 14.05 EE 457 lecture.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("the import button counts the selection and disables at zero", async () => {
    await mount(<PlynnImportSheet />, { plynn: { available: true, folder: "/m", meetings: meetings.map((m) => ({ ...m, imported: false })) } });
    const btn = await screen.findByRole("button", { name: "Import 2 recordings" });
    expect(btn).toBeEnabled();
    fireEvent.click(screen.getByLabelText("Import EE 457 lecture"));
    fireEvent.click(screen.getByLabelText("Import Standup"));
    expect(screen.getByRole("button", { name: "Import 0 recordings" })).toBeDisabled();
  });
});
