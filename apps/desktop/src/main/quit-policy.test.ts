import { describe, expect, it } from "vitest";
import { confirmQuitCopy, decideQuit, type QuitTrigger } from "./quit-policy";

describe("decideQuit", () => {
  const cell = (trigger: QuitTrigger, working: number) => decideQuit({ trigger, working }).kind;

  it("over every trigger by whether anything is working", () => {
    for (const working of [0, 1, 9]) {
      // Closing the window and ⌘Q are the same gesture: done looking, not done working.
      expect(cell("window-closed", working)).toBe("go-resident");
      expect(cell("quit", working)).toBe("go-resident");
      // An update restart deliberately leaves the daemon alone — the opposite of what this hook used
      // to do, and the reason an update no longer stops every agent.
      expect(cell("update-restart", working)).toBe("detach-and-exit");
    }
    expect(cell("quit-all", 0)).toBe("quit-all");
    expect(cell("quit-all", 1)).toBe("confirm");
    expect(decideQuit({ trigger: "quit-all", working: 3 })).toEqual({ kind: "confirm", working: 3 });
  });
});

describe("the confirmation's words", () => {
  it("names the consequence and the number, and says what the other choice is", () => {
    const one = confirmQuitCopy(1);
    expect(one.message).toBe("Quit Realm and stop it?");
    expect(one.detail).toContain("1 session is working.");
    expect(one.detail).toContain("Closing the window instead leaves them running.");
    const many = confirmQuitCopy(4);
    expect(many.message).toBe("Quit Realm and stop them?");
    expect(many.detail).toContain("4 sessions are working.");
  });
});
