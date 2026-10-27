import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ConnectionBanner } from "./App";
import { StoreContext, createAppStore } from "./state/store";
import { fakeApi } from "./state/store.test-fakes";

/* What main said before this page listened used to reach nobody: the first window of a launch that
   kept an older server loads before main publishes "stale", so the banner that should have said so
   fell back to the socket's "Connection lost — reconnecting…". */
afterEach(() => { cleanup(); delete (window as { realm?: unknown }).realm; });

const STALE = /the agent server running is the previous version/;
const banner = () => render(<StoreContext.Provider value={createAppStore(fakeApi())}><ConnectionBanner /></StoreContext.Provider>);

it("asks main on mount, so a state published before the page listened is still shown", async () => {
  // MUTANT: only subscribe, and this renders nothing at all.
  (window as { realm?: unknown }).realm = {
    onDaemonState: () => () => {},
    daemonState: () => Promise.resolve({ kind: "stale", why: "bundle" }),
  };
  banner();
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent(STALE);
});

it("lets a state pushed before the answer win over the answer", async () => {
  let push: (s: { kind: string; logPath?: string }) => void = () => {};
  let answer: (s: { kind: string; why?: string }) => void = () => {};
  (window as { realm?: unknown }).realm = {
    onDaemonState: (cb: typeof push) => { push = cb; return () => {}; },
    daemonState: () => new Promise((r) => { answer = r; }),
  };
  banner();
  act(() => push({ kind: "failed", logPath: "/tmp/realm/logs/server.log" }));
  await act(async () => answer({ kind: "stale", why: "bundle" }));
  expect(screen.getByRole("alert")).toHaveTextContent(/keeps failing to start/);
  expect(screen.queryByText(STALE)).toBeNull();
});
