import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";

/**
 * The greeting nods when its emphasised word is clicked. `greeting.test.ts` proves which sentence a
 * session gets; this proves the one unadvertised thing the line does, and — the part that actually
 * matters for something nobody is told about — that it stays out of the way: it answers only to the
 * emphasised word, it leaves no mark behind once it has run, and it is reachable by nothing else.
 *
 * What the animation LOOKS like is not assertable here (jsdom has no animation clock); §6's shared
 * `prefers-reduced-motion` kill is what takes the motion away, and styles.test.ts pins both.
 */
async function mountHero() {
  const it0 = item("i9", "s1", { kind: "session", refId: "se1", title: "s" });
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind: "fake" })],
    items: { s1: [it0] },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  // No events anywhere: an empty transcript is what puts the prompter in its hero state, which is
  // the only state the greeting exists in.
  store.setState({ sessionStatus: { se1: "idle" } });
  render(<StoreContext.Provider value={store}><SessionPane item={it0} visible /></StoreContext.Provider>);
  return screen.getByText((_, el) => el?.className === "hero-greeting") as HTMLElement;
}

describe("the hero greeting nods back", () => {
  it("marks the line when the emphasised word is clicked, and clears the mark when the nod ends", async () => {
    const line = await mountHero();
    const em = line.querySelector("em")!;
    expect(em).toBeInTheDocument(); // every variant emphasises the space or the person
    expect(line).not.toHaveAttribute("data-nod");
    fireEvent.click(em);
    expect(line).toHaveAttribute("data-nod");
    // Nothing survives the flourish: no state, no timer, and nothing for a later assertion to trip on.
    fireEvent.animationEnd(line);
    expect(line).not.toHaveAttribute("data-nod");
  });

  it("ignores a click on the rest of the line — the plain words are not a control", async () => {
    const line = await mountHero();
    fireEvent.click(line);
    expect(line).not.toHaveAttribute("data-nod");
  });

  it("re-arms, so the second click nods as well as the first", async () => {
    // The mark has to come OFF before it goes back on: re-adding an attribute the element already
    // carries changes nothing, and the animation would play once and never again.
    const line = await mountHero();
    const em = line.querySelector("em")!;
    fireEvent.click(em);
    fireEvent.animationEnd(line);
    fireEvent.click(em);
    expect(line).toHaveAttribute("data-nod");
  });
});
