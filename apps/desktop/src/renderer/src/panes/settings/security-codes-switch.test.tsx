import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SecurityCodesStatus } from "@realm/contracts";
import { SecurityCodesSwitch, securityCodesLine } from "./PasswordsSection";

/** Main's two answers, stood in: the switch's state, and setting it. */
function bridge(initial: SecurityCodesStatus, after: (on: boolean) => SecurityCodesStatus) {
  const sets: boolean[] = [];
  const realm = window.realm as unknown as Record<string, unknown> | undefined;
  (window as unknown as { realm: unknown }).realm = {
    ...realm,
    credentials: {
      codesStatus: async () => initial,
      setCodes: async (on: boolean) => { sets.push(on); return after(on); },
    },
  };
  return sets;
}

const saved = window.realm;
afterEach(() => { (window as unknown as { realm: unknown }).realm = saved; });

describe("Settings ▸ Sign-ins ▸ Security codes", () => {
  it("starts off, says what Realm reads and when, and turns on with one press", async () => {
    const sets = bridge({ enabled: false, sources: null }, (on) => ({ enabled: on, sources: { Messages: "ok", Mail: "ok" } }));
    render(<SecurityCodesSwitch />);
    const toggle = await screen.findByRole("switch", { name: "Fill codes from Messages and Mail" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/last 5 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/reads nothing while this is off/)).toBeInTheDocument();
    expect(toggle.closest("[data-no-agent]")).not.toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(sets).toEqual([true]);
  });

  it("says which source macOS is keeping from Realm, and where to grant it", () => {
    expect(securityCodesLine({ enabled: true, sources: { Messages: "no_access", Mail: "ok" } }))
      .toBe("macOS isn't letting Realm read Messages. Turn on Realm under System Settings ▸ Privacy & Security ▸ Full Disk Access.");
    expect(securityCodesLine({ enabled: true, sources: { Messages: "ok", Mail: "missing" } })).toMatch(/Only Messages can be read here\.$/);
    expect(securityCodesLine({ enabled: true, sources: { Messages: "missing", Mail: "missing" } })).toMatch(/nothing|no Messages/i);
  });
});
