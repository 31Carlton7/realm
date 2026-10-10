import { describe, expect, it } from "vitest";
import { REALM_TOOL_CLASSES, RISK_CLASSES, annotationClass, classifyTool, floorWord, verbOf } from "./risk-class";
import { VENDOR_TOOL_CLASSES, connectorAtHost, vendorToolClass } from "./risk-vendors";
import { CONNECTORS } from "./connectors";

const server = (tool: string, annotations?: Record<string, unknown> | null, host: string | null = "crm.example.com") =>
  classifyTool({ connector: "mcp:01SERVER", tool, host, annotations });

describe("classifyTool — a server's annotations, read as the MCP spec defines them", () => {
  it("maps each hint, with the spec's defaults (destructive and open-world unless said otherwise)", () => {
    expect(server("read_thing", { readOnlyHint: true })).toMatchObject({ class: "read", source: "server" });
    expect(server("tidy_cache", { openWorldHint: false })).toMatchObject({ class: "internal-write", source: "server" });
    expect(server("save_thing", { destructiveHint: false })).toMatchObject({ class: "reversible-external", source: "server" });
    // THE MUTANT: a missing destructiveHint read as false — the spec's default is true.
    expect(server("save_thing", { readOnlyHint: false })).toMatchObject({ class: "irreversible-external", source: "server" });
    expect(server("save_thing", { openWorldHint: true })).toMatchObject({ class: "irreversible-external", source: "server" });
  });

  it("calls a tool with no hints at all unclassified, and treats it as one that can't be taken back", () => {
    for (const a of [undefined, null, {}, { title: "Send it" }]) {
      expect(server("update_deal", a as never)).toMatchObject({ class: "irreversible-external", source: "unclassified" });
    }
  });
});

describe("the verb floor", () => {
  it("does not believe a server that labels a send read-only: its other hints decide, never below reversible", () => {
    // THE MUTANT: a floor that is skipped for the annotations source.
    expect(server("send_quietly", { readOnlyHint: true })).toMatchObject({ class: "irreversible-external", source: "server", floor: "send" });
    expect(server("send_quietly", { readOnlyHint: true, destructiveHint: false })).toMatchObject({ class: "reversible-external", floor: "send" });
    expect(server("deleteRecord", { openWorldHint: false })).toMatchObject({ class: "irreversible-external", floor: "delete" });
    expect(server("payInvoice", { readOnlyHint: true })).toMatchObject({ floor: "pay" });
  });

  it("splits a name on _, - and camelCase, and counts message, email, order and release only as the first word", () => {
    expect(floorWord("send_message")).toBe("send");
    expect(floorWord("notion-share-page")).toBe("share");
    expect(floorWord("mergePullRequest")).toBe("merge");
    expect(floorWord("message_user")).toBe("message");
    expect(floorWord("email_contact")).toBe("email");
    expect(floorWord("get_email")).toBeNull();
    expect(floorWord("get_message")).toBeNull();
    expect(floorWord("get_release")).toBeNull();
    expect(floorWord("sender_profile")).toBeNull();
    expect(server("get_message", { readOnlyHint: true })).toMatchObject({ class: "read", floor: null });
  });

  it("leaves a class the source already put at or above reversible alone, with no floor named", () => {
    expect(server("send_thing", { destructiveHint: false })).toMatchObject({ class: "reversible-external", floor: null });
  });
});

describe("the vendor table", () => {
  it("is matched by the connector's host and wins over what the server says about itself", () => {
    const linear = (tool: string, annotations?: Record<string, unknown>) => classifyTool({ connector: "mcp:01LINEAR", tool, host: "mcp.linear.app", annotations });
    // THE MUTANT: annotations read before the vendor table.
    expect(linear("save_issue", { readOnlyHint: true })).toMatchObject({ class: "reversible-external", source: "vendor" });
    expect(linear("list_issues")).toMatchObject({ class: "read", source: "vendor" });
    expect(linear("merge_diff")).toMatchObject({ class: "irreversible-external", source: "vendor" });
    expect(linear("get_release")).toMatchObject({ class: "read", source: "vendor" });
    // A tool the table does not name falls through to the server's word.
    expect(linear("brand_new_tool", { readOnlyHint: true })).toMatchObject({ class: "read", source: "server" });
    expect(linear("brand_new_tool")).toMatchObject({ source: "unclassified" });
  });

  it("names only connectors Realm offers, and finds each by its endpoint's host", () => {
    for (const id of Object.keys(VENDOR_TOOL_CLASSES)) {
      const c = CONNECTORS.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(connectorAtHost(new URL(c!.url).host)?.id).toBe(id);
    }
    expect(vendorToolClass("evil.example.com", "save_issue")).toBeNull();
  });

  it("never classes a name the floor catches below reversible", () => {
    for (const [id, tools] of Object.entries(VENDOR_TOOL_CLASSES)) {
      for (const [tool, cls] of Object.entries(tools)) {
        if (floorWord(tool)) expect(`${id} ${tool} ${cls}`).not.toMatch(/ (read|internal-write)$/);
      }
    }
  });
});

describe("Realm's own tools", () => {
  it("are classed by Realm's table, which the verb floor does not second-guess", () => {
    expect(classifyTool({ connector: "realm:realm-team", tool: "record_update" })).toMatchObject({ class: "internal-write", source: "realm" });
    expect(classifyTool({ connector: "realm:realm-memory", tool: "memory_remove" })).toMatchObject({ class: "internal-write", floor: null });
    expect(classifyTool({ connector: "realm:realm-vault", tool: "vault_http" })).toMatchObject({ class: "irreversible-external" });
    expect(classifyTool({ connector: "realm:realm-team", tool: "record_read" })).toMatchObject({ class: "read", asksFirst: expect.stringMatching(/activity/) });
    // A tool Realm's table does not know is not trusted for being Realm's.
    expect(classifyTool({ connector: "realm:realm-team", tool: "brand_new" })).toMatchObject({ class: "irreversible-external", source: "unclassified" });
  });

  it("names every tool by its provider, in one of the four classes, and only a read may still ask first", () => {
    for (const [name, c] of Object.entries(REALM_TOOL_CLASSES)) {
      expect(name).toMatch(/^realm-[a-z]+__[a-z_]+$/);
      expect(RISK_CLASSES).toContain(c.class);
      if (c.asksFirst) expect(c.class, name).toBe("read");
    }
  });
});

describe("a person's override", () => {
  it("raises a class freely", () => {
    expect(classifyTool({ connector: "mcp:01S", tool: "read_thing", annotations: { readOnlyHint: true } }, { class: "reversible-external", verb: "sync", sealed: false }))
      .toMatchObject({ class: "reversible-external", source: "you", verb: "sync", overrideIgnored: false });
  });

  it("lowers one only when sealed — an unconfirmed lowering is set aside and said so", () => {
    const t = { connector: "mcp:01S", tool: "update_deal", annotations: null };
    // THE MUTANT: an unsealed lowering taken as written.
    expect(classifyTool(t, { class: "read", verb: null, sealed: false })).toMatchObject({ class: "irreversible-external", source: "unclassified", overrideIgnored: true });
    expect(classifyTool(t, { class: "read", verb: null, sealed: true })).toMatchObject({ class: "read", source: "you", overrideIgnored: false });
  });
});

describe("verbs", () => {
  it("take the first word that is a verb, else the first word", () => {
    expect(verbOf("send_message")).toBe("send");
    expect(verbOf("browser_fill_credential")).toBe("fill");
    expect(verbOf("notion-create-pages")).toBe("create");
    expect(verbOf("getDesignContext")).toBe("get");
    expect(verbOf("acme")).toBe("acme");
  });

  it("annotationClass is the spec's table and nothing else", () => {
    expect(annotationClass({ readOnlyHint: true, destructiveHint: true })).toBe("read");
    expect(annotationClass({ readOnlyHint: true }, true)).toBe("irreversible-external");
  });
});
