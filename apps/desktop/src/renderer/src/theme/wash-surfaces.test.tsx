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
const washed = (el: HTMLElement) => {
  expect(el.classList.contains("wash"), el.className).toBe(true);
  for (const name of GEOMETRY) expect(el.style.getPropertyValue(name), name).not.toBe("");
  return el;
};

describe("which surfaces wear the decorative wash", () => {
  it("Notifications takes the colour field, and no texture", async () => {
    const { container } = await mount(<NotificationsPage item={page("notifications-page")} visible />);
    const root = washed(container.querySelector<HTMLElement>(".notifications-page-pane")!);
    // `.page` is a --canvas ground, where the contrast budget for a luminance excursion is zero.
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
    const { container } = await mount(<><NotificationsPage item={page("notifications-page")} visible /><Onboarding /></>);
    const a = GEOMETRY.map((n) => container.querySelector<HTMLElement>(".notifications-page-pane")!.style.getPropertyValue(n)).join();
    const b = GEOMETRY.map((n) => screen.getByLabelText("Welcome to Realm").style.getPropertyValue(n)).join();
    expect(a).not.toBe(b);
  });

  it("holds the field still across a re-render, so nothing reshuffles under the reader", async () => {
    const store = createAppStore(fakeApi({ spaces: [], items: {} }));
    await store.getState().boot();
    const ui = <StoreContext.Provider value={store}><NotificationsPage item={page("notifications-page")} visible /></StoreContext.Provider>;
    const { container, rerender } = render(ui);
    const read = () => GEOMETRY.map((n) => container.querySelector<HTMLElement>(".notifications-page-pane")!.style.getPropertyValue(n)).join();
    const before = read();
    rerender(ui);
    expect(read()).toBe(before);
  });
});
