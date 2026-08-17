import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "./index";
describe("contracts", () => { it("loads", () => expect(CONTRACTS_VERSION).toBe(1)); });
