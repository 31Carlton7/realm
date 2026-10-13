import { describe, expect, it } from "vitest";
import { userHomeFor } from "./harness-home";

const real = () => "/Users/someone";

describe("the home realm-server reads skills and commands from", () => {
  it("is the machine's own on a real launch", () => {
    expect(userHomeFor({}, real)).toBe("/Users/someone");
  });

  it("is the one a harness names", () => {
    expect(userHomeFor({ REALM_ENABLE_FAKE_AGENT: "1", REALM_USER_HOME: "/tmp/capture/user" }, real)).toBe("/tmp/capture/user");
  });

  it("ignores a named home without the harness flag", () => {
    expect(userHomeFor({ REALM_USER_HOME: "/tmp/capture/user" }, real)).toBe("/Users/someone");
    expect(userHomeFor({ REALM_ENABLE_FAKE_AGENT: "1", REALM_USER_HOME: " " }, real)).toBe("/Users/someone");
  });
});
