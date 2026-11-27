import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { agentFillNote, sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, session } from "../../state/store.test-fakes";
import { Transcript } from "./Transcript";
import { reduceAll } from "./transcript-model";
import { exportSessionMarkdown } from "./export-session";

const ME = "01JC0000000000000000000001";

afterEach(() => cleanup());

describe("the line an agent's sign-in fill leaves in its chat", () => {
  const events = [sessionEvent("signin_filled", { site: "https://example.com", kind: "generated", note: agentFillNote("generated", "example.com") })];

  it("says what Realm filled and where, as a note", async () => {
    const store = createAppStore(fakeApi({ sessions: [session(ME, "s1")] })); await store.getState().boot();
    render(<StoreContext.Provider value={store}>
      <Transcript transcript={reduceAll(events)} sessionStatus="idle" onDecide={() => {}} sessionId={ME} />
    </StoreContext.Provider>);
    expect(screen.getByRole("note").textContent).toBe("Realm created a password for example.com, saved in Settings ▸ Passwords");
  });

  it("is in an exported transcript too", () => {
    expect(exportSessionMarkdown({ title: "t", transcript: reduceAll(events), agentLabel: "Claude", model: null, cwd: null, now: 0 })).toContain("> **Sign-in:** Realm created a password for example.com");
  });
});
