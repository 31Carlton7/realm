import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore, type Api } from "../state/store";

const api: Api = {
  listProfiles: async () => [{ id: "p1", name: "Work", icon: "briefcase", color: "#000", sortOrder: 0, createdAt: 0, updatedAt: 0 },
                              { id: "p2", name: "School", icon: "cap", color: "#000", sortOrder: 1, createdAt: 0, updatedAt: 0 }],
  listSpaces: async (pid) => pid === "p1" ? [{ id: "s1", profileId: "p1", name: "Versed", icon: "folder", sortOrder: 0, folderPath: "/", layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 }] : [],
  listItems: async () => [{ id: "i1", spaceId: "s1", kind: "terminal", title: "Terminal", sortOrder: 0, pinned: false, refId: "t1", createdAt: 0, updatedAt: 0 }],
  listProjects: async () => [],
  createProfile: vi.fn(), createSpace: vi.fn(), createProject: vi.fn(), setLayout: vi.fn(async (id, layout) => ({ id, layout } as never)),
  createTerminal: vi.fn(), deleteItem: vi.fn(), pickFolder: vi.fn(async () => null), disposeTerminal: vi.fn(),
};

describe("Sidebar", () => {
  it("renders profiles, spaces of the active profile, and items of the active space", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
    expect(screen.getByRole("button", { name: /Work/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /School/ })).toBeInTheDocument();
    expect(screen.getByText("Versed")).toBeInTheDocument();
    expect(screen.getByText("Terminal")).toBeInTheDocument();
  });
  it("switching profile empties spaces list", async () => {
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: /School/ }));
    await waitFor(() => expect(screen.queryByText("Versed")).not.toBeInTheDocument());
  });
});
