import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, session } from "../../state/store.test-fakes";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";

const ME = "01JC0000000000000000000001";

async function mount(spaceId: string) {
  const store = createAppStore(fakeApi({ sessions: [session(ME, "s1")] })); await store.getState().boot();
  await store.getState().selectSpace("s1");
  render(<StoreContext.Provider value={store}>
    <Transcript transcript={reduceAll([sessionEvent("space_made", { spaceId, name: "Homework", note: "Made the space Homework" })])}
      sessionStatus="idle" onDecide={() => {}} sessionId={ME} />
  </StoreContext.Provider>);
  return store;
}

afterEach(() => cleanup());

describe("the line an agent's space_create leaves in its chat", () => {
  it("says which space was made, and Open moves the window there", async () => {
    const store = await mount("s2");
    expect(screen.getByText("Made the space Homework")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("keeps the sentence and drops Open once the space is gone", async () => {
    await mount("gone");
    expect(screen.getByText("Made the space Homework")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });
});
