import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, skillRow, type FakeData } from "../../state/store.test-fakes";

const pageItem = (spaceId: string) =>
  item(`lib-${spaceId}`, spaceId, { kind: "library-page", title: "Library", refId: PAGE_REF_IDS["library-page"] });

const DOC = "# Using mac\n\nRun `mac --help` first.\n\n## Calendar\n\nEvents are added with `mac cal add`.\n";

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({
    skills: { s1: [skillRow("mac"), skillRow("broken", { valid: false, reason: "frontmatter has no `name`", description: "" })] },
    skillDocs: {
      mac: {
        body: DOC,
        frontmatter: { name: "mac", description: "does mac", license: "MIT" },
        resources: [
          { rel: "references/verbs.md", size: 120, readable: true },
          { rel: "logo.png", size: 2048, readable: false },
        ],
      },
    },
    skillFiles: { "mac/references/verbs.md": "# Verbs\n\n`add`, `list`, `complete`.\n" },
    ...overrides,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><LibraryPage item={pageItem("s1")} visible /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("radio", { name: "Skills" }));
  return { store, api, ...r };
}

/** The list row's name is the door. */
const openSkill = async (name: string) => {
  fireEvent.click(await screen.findByRole("button", { name }));
};

describe("the Library's skill viewer", () => {
  it("opens a skill from its row and shows the SKILL.md document, not just its frontmatter", async () => {
    const { api } = await mount();
    await openSkill("mac");
    await waitFor(() => expect(api.calls).toContain("readSkill:s1:mac"));
    // The prose an agent is actually handed — which no surface in the app showed before this page.
    expect(await screen.findByRole("heading", { name: "Using mac", level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Events are added with/)).toBeInTheDocument();
  });

  it("takes the page's title and gives back a way to the list, rather than opening a pane", async () => {
    await mount();
    await openSkill("mac");
    // One h1 for the page, and it is the skill's name — not "Library" above a second heading.
    expect(await screen.findByRole("heading", { name: "mac", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Library" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to skills" }));
    expect(await screen.findByRole("heading", { name: "Library", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Skills" })).toBeChecked();
  });

  it("carries the row's own switch, on the same per-space semantics — one on/off, not two", async () => {
    const { api } = await mount();
    await openSkill("mac");
    const toggle = await screen.findByRole("switch", { name: "Skill mac in this space" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(api.calls).toContain("setSkillEnabled:s1:mac=false"));
  });

  it("shows the frontmatter keys Realm does NOT read, which have nowhere else to appear", async () => {
    await mount();
    await openSkill("mac");
    expect(await screen.findByText("license")).toBeInTheDocument();
    expect(screen.getByText("MIT")).toBeInTheDocument();
    // …and does not restate the two that are already the title and the paragraph above.
    expect(screen.queryByText("description")).not.toBeInTheDocument();
  });

  it("builds its contents rail out of the document's own headings", async () => {
    await mount();
    await openSkill("mac");
    const toc = await screen.findByRole("navigation", { name: "Sections of this skill" });
    expect(within(toc).getByRole("link", { name: "Using mac" })).toBeInTheDocument();
    expect(within(toc).getByRole("link", { name: "Calendar" })).toBeInTheDocument();
  });

  it("lists the files bundled beside the SKILL.md and opens a readable one in place", async () => {
    const { api } = await mount();
    await openSkill("mac");
    // A file Realm cannot show is still LISTED — "what else is in here" is the question.
    expect(await screen.findByText("logo.png")).toBeInTheDocument();
    expect(screen.getByText(/not text Realm can show/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /references\/verbs\.md/ }));
    await waitFor(() => expect(api.calls).toContain("readSkillFile:s1:mac:references/verbs.md"));
    expect(await screen.findByRole("heading", { name: "Verbs" })).toBeInTheDocument();
    // …and the file it opened is NOT folded into the skill's own contents rail.
    const toc = screen.getByRole("navigation", { name: "Sections of this skill" });
    expect(within(toc).queryByRole("link", { name: "Verbs" })).not.toBeInTheDocument();
  });

  it("opens an INVALID skill too, showing the reason instead of a document it cannot render", async () => {
    await mount();
    await openSkill("broken");
    expect(await screen.findByText("frontmatter has no `name`")).toBeInTheDocument();
    // No switch: an invalid skill is never handed to an agent whatever the flag says.
    expect(screen.queryByRole("switch", { name: "Skill broken in this space" })).not.toBeInTheDocument();
  });
});

describe("reaching one skill from the lists that are not the Library's", () => {
  it("a space page's Skills row opens the SAME viewer, on the Library page, rather than a copy of it", async () => {
    const api = fakeApi({
      skills: { s1: [skillRow("mac")] },
      skillDocs: { mac: { body: DOC, frontmatter: { name: "mac", description: "does mac" } } },
    });
    const store = createAppStore(api);
    await store.getState().boot();
    // What the space page's row does: name the skill, then go to the page that shows it.
    await store.getState().openSkillPage("mac");
    expect(store.getState().librarySkill.s1).toBe("mac");
    expect((store.getState().pageOverlay?.kind === "library-page")).toBe(true);

    render(<StoreContext.Provider value={store}><LibraryPage item={pageItem("s1")} visible /></StoreContext.Provider>);
    expect(await screen.findByRole("heading", { name: "mac", level: 1 })).toBeInTheDocument();
    // …and going back lands on Skills, the list this page shows a skill from — never on Files, a
    // tab a user arriving from the space page never chose.
    fireEvent.click(screen.getByRole("button", { name: "Back to skills" }));
    expect(await screen.findByRole("radio", { name: "Skills" })).toBeChecked();
  });
});
