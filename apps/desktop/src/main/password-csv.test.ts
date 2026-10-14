import { describe, expect, it } from "vitest";
import { parseCsv, parsePasswordExport } from "./password-csv";

describe("parsePasswordExport", () => {
  it("reads the Passwords app's export", () => {
    const text = "Title,URL,Username,Password,Notes,OTPAuth\r\n"
      + "example.com (ann),https://example.com/login,ann@example.com,\"p,a\"\"ss\",,\r\n"
      + "Bare,example.org,bob,secret,,\r\n";
    const r = parsePasswordExport(text);
    expect(r).toEqual({
      ok: true, skipped: 0,
      rows: [
        { origin: "https://example.com", username: "ann@example.com", password: "p,a\"ss", title: "example.com (ann)" },
        { origin: "https://example.org", username: "bob", password: "secret", title: "Bare" },
      ],
    });
  });

  it("reads Chrome's, with the columns in its own order and a BOM in front", () => {
    const r = parsePasswordExport("﻿name,url,username,password,note\nsite,https://a.example.com/,u,pw,\n");
    expect(r.ok && r.rows).toEqual([{ origin: "https://a.example.com", username: "u", password: "pw", title: "site" }]);
  });

  it("reads Bitwarden's logins and skips its notes and cards", () => {
    const text = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n"
      + ",,login,Site,,,0,\"https://x.example.com,https://y.example.com\",me,pw1,\n"
      + ",,note,A note,secret note,,0,,,,\n"
      + ",,card,Visa,,,0,,,,\n";
    const r = parsePasswordExport(text);
    expect(r).toEqual({ ok: true, skipped: 2, rows: [{ origin: "https://x.example.com", username: "me", password: "pw1", title: "Site" }] });
  });

  it("skips app entries and rows with no password or no site", () => {
    const text = "url,username,password\nandroid://abc@com.example,u,p\nhttps://ok.example.com,u,\n,u,p\nhttps://fine.example.com,u,p\n";
    const r = parsePasswordExport(text);
    expect(r.ok && r.rows.map((x) => x.origin)).toEqual(["https://fine.example.com"]);
    expect(r.ok && r.skipped).toBe(3);
  });

  it("refuses a file that is not a password export, without quoting it", () => {
    const r = parsePasswordExport("a,b\nhunter2,x\n");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("refuses an unterminated quote", () => {
    const r = parsePasswordExport("url,password\nhttps://a.com,\"hunter2\n");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
});

describe("parseCsv", () => {
  it("keeps newlines inside quotes and a trailing field with no newline", () => {
    expect(parseCsv("a,\"b\nc\"\nd,e")).toEqual([["a", "b\nc"], ["d", "e"]]);
  });
});
