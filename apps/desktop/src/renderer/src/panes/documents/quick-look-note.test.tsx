import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Item } from "@realm/contracts";
import { DocumentsPane } from "./DocumentsPane";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

/** The pane subscribes to `documents.fileChanged` through the rpc singleton; inert here. */
vi.mock("../../rpc/client", () => ({ rpc: () => ({ on: () => () => {} }) }));

const DOCS_ID = "docs1";
const paneItem: Item = item("i1", "s1", { kind: "documents", title: "Documents", refId: DOCS_ID });

function mount(path: string) {
  const api = fakeApi({
    documentWorkspaces: { [DOCS_ID]: { id: DOCS_ID, spaceId: "s1", environmentId: "env-s1", openPaths: [path], activePath: path, createdAt: 0, updatedAt: 0 } },
    documentFiles: { [DOCS_ID]: { [path]: "" } },
  });
  render(<StoreContext.Provider value={createAppStore(api)}><DocumentsPane item={paneItem} visible /></StoreContext.Provider>);
}

/** The line under a Quick Look render states its limits once. What it says has to be true of the file. */
describe("the note under a Quick Look render", () => {
  it("tells a document's reader the text cannot be selected", async () => {
    mount("report.docx");
    await screen.findByAltText("Preview of report.docx");
    expect(screen.getByText(/the text cannot be selected/)).toBeTruthy();
  });

  it("says nothing under a picture, which has no text and no pages", async () => {
    // THE MUTANT: drop the picture test from the note's condition. A screenshot then sits over a
    // line saying its text cannot be selected and it may show only its first page.
    mount("shots/gradient.png");
    await screen.findByAltText("Preview of gradient.png");
    expect(screen.queryByText(/the text cannot be selected/)).toBeNull();
  });
});
