import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PAGE_REF_IDS } from "@realm/contracts";
import { Sheet } from "../components/Sheet";
import { Onboarding } from "../components/Onboarding";
import { SettingsPage } from "../panes/settings/SettingsPage";
import { NotificationsPage } from "../panes/notifications/NotificationsPage";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi, item } from "../state/store.test-fakes";

async function mount(ui: React.ReactElement) {
  const store = createAppStore(fakeApi({ spaces: [], items: {} }));
  await store.getState().boot();
  return render(<StoreContext.Provider value={store}>{ui}</StoreContext.Provider>);
}
const page = (kind: "settings-page" | "notifications-page") =>
  item(`w-${kind}`, "s1", { kind, title: kind, refId: PAGE_REF_IDS[kind] });

const GEOMETRY = ["--grain-hue", "--grain-x", "--grain-y", "--grain-spread"];

describe("which surfaces wear the decorative wash", () => {
  it("Notifications is plain too — it was the last page wearing the field, and it wore it worst", async () => {
    /* Reversed deliberately. Settings lost the wash because a tint over a form reads as bleed into
       the controls; Notifications had the same problem for a sharper reason — a decorated ground
       under a list of things asking for your attention competes with the attention. That left the
       app with exactly one washed pane, which is not a system, it is a leftover.

       The named mutant is `className="page notifications-page-pane wash"` coming back. */
    const { container } = await mount(<NotificationsPage item={page("notifications-page")} visible />);
    const root = container.querySelector<HTMLElement>(".notifications-page-pane")!;
    expect(root.classList.contains("wash")).toBe(false);
    expect(root.hasAttribute("data-grain")).toBe(false);
  });

  it("Settings is plain — a page of controls someone sits on all day is not decorated", async () => {
    // It wore the field once. Over a form it read as a tint bleeding into the controls rather than as
    // a ground, so it went; the named mutant is `className="page settings-page-pane wash"` coming back.
    const { container } = await mount(<SettingsPage item={page("settings-page")} visible />);
    const root = container.querySelector<HTMLElement>(".settings-page-pane")!;
    expect(root.classList.contains("wash")).toBe(false);
    for (const name of GEOMETRY) expect(root.style.getPropertyValue(name), name).toBe("");
  });

  it("the first-run card is plain too — and it was the last surface in the app wearing one", async () => {
    /* The third and last of them, and the sharpest case of the same argument. Settings lost the wash
       because a tint over a form reads as bleed into the controls; Notifications because a decorated
       ground under things asking for your attention competes with the attention. A first run is both
       at once: it is the only screen in Realm where nothing is familiar yet, so every gradient on it
       is one more thing to work out before the two decisions it actually asks for.

       The named mutant is `className="sheet onboarding wash" data-grain` coming back. Nothing in the
       app wears `.wash` now — the rules and `theme/grain.ts` are still here and still tested, and
       this is the test that says nobody is using them. */
    await mount(<Onboarding />);
    const card = screen.getByLabelText("Welcome to Realm");
    expect(card.classList.contains("wash")).toBe(false);
    expect(card.hasAttribute("data-grain")).toBe(false);
    for (const name of GEOMETRY) expect(card.style.getPropertyValue(name), name).toBe("");
  });

  it("leaves every other sheet plain — a surface that exists to ask one question is not decorated", async () => {
    await mount(<Sheet title="Delete this space?" onClose={() => {}}>body</Sheet>);
    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("wash")).toBe(false);
    expect(dialog.style.getPropertyValue("--grain-hue")).toBe("");
  });

  /* The two tests that used to sit here compared one washed surface against another and held one
     still across a re-render. Both read their geometry off surfaces that no longer carry any, so
     both had quietly become assertions that "" is "" — and `theme/grain.test.ts` tests `grainVars`
     itself, which is where the per-surface seed and its stability actually live. */
});
