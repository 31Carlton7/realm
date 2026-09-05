import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
const washed = (el: HTMLElement) => {
  expect(el.classList.contains("wash"), el.className).toBe(true);
  for (const name of GEOMETRY) expect(el.style.getPropertyValue(name), name).not.toBe("");
  return el;
};

describe("which surfaces wear the decorative wash", () => {
  it("Settings and Notifications take the colour field, and no texture", async () => {
    for (const kind of ["settings-page", "notifications-page"] as const) {
      const { container } = await mount(kind === "settings-page"
        ? <SettingsPage item={page(kind)} visible />
        : <NotificationsPage item={page(kind)} visible />);
      const root = washed(container.querySelector<HTMLElement>(`.${kind}-pane`)!);
      // `.page` is a --canvas ground, where the contrast budget for a luminance excursion is zero.
      expect(root.hasAttribute("data-grain")).toBe(false);
      cleanup();
    }
  });

  it("the first-run card takes the grain too, because a --surface ground can pay for it", async () => {
    await mount(<Onboarding />);
    const card = washed(screen.getByLabelText("Welcome to Realm"));
    expect(card.hasAttribute("data-grain")).toBe(true);
  });

  it("leaves every other sheet plain — a surface that exists to ask one question is not decorated", async () => {
    await mount(<Sheet title="Delete this space?" onClose={() => {}}>body</Sheet>);
    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("wash")).toBe(false);
    expect(dialog.style.getPropertyValue("--grain-hue")).toBe("");
  });

  it("gives two surfaces open together two different fields", async () => {
    const { container } = await mount(<><SettingsPage item={page("settings-page")} visible />
      <NotificationsPage item={page("notifications-page")} visible /></>);
    const [a, b] = ["settings-page-pane", "notifications-page-pane"]
      .map((c) => GEOMETRY.map((n) => container.querySelector<HTMLElement>(`.${c}`)!.style.getPropertyValue(n)).join());
    expect(a).not.toBe(b);
  });

  it("holds the field still across a re-render, so nothing reshuffles under the reader", async () => {
    const store = createAppStore(fakeApi({ spaces: [], items: {} }));
    await store.getState().boot();
    const ui = <StoreContext.Provider value={store}><SettingsPage item={page("settings-page")} visible /></StoreContext.Provider>;
    const { container, rerender } = render(ui);
    const read = () => GEOMETRY.map((n) => container.querySelector<HTMLElement>(".settings-page-pane")!.style.getPropertyValue(n)).join();
    const before = read();
    rerender(ui);
    expect(read()).toBe(before);
  });
});
