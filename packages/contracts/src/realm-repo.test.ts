import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_REQUEST_URL, REALM_REPO_URL, bugReportUrl } from "./realm-repo";

const FORMS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "ISSUE_TEMPLATE");

describe("the links to Realm's repository", () => {
  /* THE mutant: a form renamed or a field id changed in the YAML, and every Report a Bug in the app
     opens GitHub's blank chooser, or a form with the version left empty, with nothing failing here. */
  it("name issue forms that exist, and a field the bug form has", () => {
    for (const url of [bugReportUrl("2.6.3"), FEATURE_REQUEST_URL]) {
      const form = new URL(url).searchParams.get("template")!;
      expect(existsSync(join(FORMS, form)), form).toBe(true);
    }
    const bug = readFileSync(join(FORMS, "bug.yml"), "utf8");
    for (const field of new URL(bugReportUrl("2.6.3")).searchParams.keys()) {
      if (field !== "template") expect(bug, field).toMatch(new RegExp(`^\\s+id: ${field}$`, "m"));
    }
  });

  it("fill the version in as it is written", () => {
    expect(new URL(bugReportUrl("2.7.0-beta.1")).searchParams.get("version")).toBe("2.7.0-beta.1");
    expect(bugReportUrl("2.6.3").startsWith(`${REALM_REPO_URL}/issues/new?`)).toBe(true);
  });
});
