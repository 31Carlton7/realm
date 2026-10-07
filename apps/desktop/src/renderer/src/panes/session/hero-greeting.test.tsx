import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Environment } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { heroGreeting } from "./greeting";
import { SessionPane } from "./SessionPane";

/** A session id whose greeting addresses the person by name — the fake host's user is "Carlton" — so
 *  the nod, which answers only to the person's name now, has something to answer to. */
const namedSeed = (): string => {
  for (let i = 0; ; i++) {
    const id = `se${i}`;
    if (heroGreeting({ spaceName: "Versed", userName: "Carlton", seed: id }).some((p) => p.em && !p.place)) return id;
  }
};
const env = (id: string, kind: Environment["kind"], path: string): Environment =>
  ({ id, spaceId: "s1", path, branch: null, kind, portBlockStart: null, createdAt: 0, updatedAt: 0 });

/**
 * The greeting nods when its emphasised word is clicked. `greeting.test.ts` proves which sentence a
 * session gets; this proves the one unadvertised thing the line does, and — the part that actually
 * matters for something nobody is told about — that it stays out of the way: it answers only to the
 * emphasised word, it leaves no mark behind once it has run, and it is reachable by nothing else.
 *
 * What the animation LOOKS like is not assertable here (jsdom has no animation clock); §6's shared
 * `prefers-reduced-motion` kill is what takes the motion away, and styles.test.ts pins both.
 */
async function mountHero(o: { id?: string; cwd?: string; environmentId?: string; environments?: Environment[] } = {}) {
  const id = o.id ?? namedSeed();
  const it0 = item("i9", "s1", { kind: "session", refId: id, title: "s" });
  const api = fakeApi({
    sessions: [session(id, "s1", { status: "idle", agentKind: "fake", ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.environmentId ? { environmentId: o.environmentId } : {}) })],
    items: { s1: [it0] },
    environments: o.environments ? { s1: o.environments } : {},
  });
  const store = createAppStore(api);
  await store.getState().boot();
  // No events anywhere: an empty transcript is what puts the prompter in its hero state, which is
  // the only state the greeting exists in.
  store.setState({ sessionStatus: { [id]: "idle" } });
  render(<StoreContext.Provider value={store}><SessionPane item={it0} visible /></StoreContext.Provider>);
  const line = screen.getByText((_, el) => el?.className === "hero-greeting") as HTMLElement;
  return Object.assign(line, { store });
}

describe("the greeting's place is a link to the space's page", () => {
  /* Codex names the project in its empty state and links it; Realm's line named the space and nodded
     when it was clicked. THE MUTANTS: leave it an <em> (a word that looks like a name and goes
     nowhere), or name the space when the session is working somewhere else entirely. */
  it("is a real button — keyboard-reachable — that opens the space's page", async () => {
    const line = await mountHero({ id: "se1" });
    const link = line.querySelector<HTMLButtonElement>(".hero-greeting-place")!;
    expect(link.tagName).toBe("BUTTON");
    expect(link).toHaveAttribute("type", "button");
    expect(link.tabIndex).toBe(0);
    expect(link).toHaveTextContent("Versed");
    expect(link).toHaveAccessibleName("Versed");
    expect(link).toHaveAttribute("title", "Open Versed");
    fireEvent.click(link);
    expect(line.store.getState().pageOverlay).toEqual({ kind: "space-page", refId: "s1", spaceId: "s1" });
    // A link is not the nod: clicking where the line goes leaves the flourish alone.
    expect(line).not.toHaveAttribute("data-nod");
  });

  it("names the checkout instead when the session is not in the space's own folder, and still leads to the space", async () => {
    const line = await mountHero({ id: "se1", cwd: "/Users/me/code/stora-platform", environmentId: "e-co",
      environments: [env("e-primary", "primary", "/tmp"), env("e-co", "checkout", "/Users/me/code/stora-platform")] });
    const link = await waitFor(() => {
      const el = line.querySelector<HTMLButtonElement>(".hero-greeting-place")!;
      if (el.textContent !== "stora-platform") throw new Error(`still ${el.textContent}`);
      return el;
    });
    expect(link).toHaveAttribute("title", "Open Versed");
    fireEvent.click(link);
    expect(line.store.getState().pageOverlay).toEqual({ kind: "space-page", refId: "s1", spaceId: "s1" });
  });

  it("once the environments have loaded, their kind decides — the space's own folder is the space, whatever its path says", async () => {
    // The space's row says /tmp; its primary checkout is somewhere else on disk. The kind is the
    // authority: a path compared by string is only the stand-in for before it has arrived.
    const line = await mountHero({ id: "se1", cwd: "/Volumes/Work/versed", environmentId: "e-primary",
      environments: [env("e-primary", "primary", "/Volumes/Work/versed")] });
    await waitFor(() => expect(line.store.getState().environments["e-primary"]).toBeDefined());
    expect(line.querySelector(".hero-greeting-place")).toHaveTextContent("Versed");
  });

  it("before the environments have loaded, the paths decide — a worktree is named by its own folder", async () => {
    const line = await mountHero({ id: "se1", cwd: "/tmp/worktrees/fix-the-mapper/" });
    expect(line.querySelector(".hero-greeting-place")).toHaveTextContent("fix-the-mapper");
  });
});

describe("the hero greeting nods back", () => {
  it("marks the line when the emphasised word is clicked, and clears the mark when the nod ends", async () => {
    const line = await mountHero();
    const em = line.querySelector("em")!;
    expect(em).toBeInTheDocument(); // the person's name — the space's is a link now
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

describe("the greeting is one run of text", () => {
  it("puts the whole sentence in a single child, so flex does not eat the space before the name", async () => {
    // The box is a flex container. Rendering each run as its own child makes each one an anonymous
    // flex item, and an item's leading and trailing spaces collapse away — "…working on inRealm?".
    const line = await mountHero();
    expect(line.childNodes).toHaveLength(1);
    const span = line.firstChild as HTMLElement;
    expect(span.tagName).toBe("SPAN");
    expect(span.querySelector("em, .hero-greeting-place")).toBeInTheDocument();
    expect(span.textContent).toMatch(/ \S+\?$|\. *$/);
  });
});
