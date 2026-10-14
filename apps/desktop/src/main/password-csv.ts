import { normalizeOrigin } from "@realm/contracts";

/**
 * Reading a password export: the Passwords app's (File ▸ Export All Passwords:
 * Title,URL,Username,Password,Notes,OTPAuth), Chrome's (name,url,username,password,note), 1Password's
 * (Title,Url,Username,Password,…), Bitwarden's (…,type,name,…,login_uri,login_username,login_password,…)
 * and Firefox's (url,username,password,…). Columns are found by their heading, so the order a manager
 * writes them in does not matter.
 *
 * Every value in the file is the user's secret or next to one, so nothing this returns or throws
 * quotes the file: an error names a line number at most. What comes back is the rows a sign-in can be
 * made of — a site Realm can pin to and a password — and a count of the rest (notes, cards, app
 * entries, rows with no site).
 */
export type ImportedPassword = { origin: string; username: string; password: string; title: string };

export type ParsedPasswordExport =
  | { ok: true; rows: ImportedPassword[]; skipped: number }
  | { ok: false; error: string };

/** A file bigger than this is not a password export. Bounds the parse, not a design limit. */
export const PASSWORD_EXPORT_MAX_BYTES = 20 * 1024 * 1024;

const COLUMNS = {
  url: ["url", "login_uri", "website", "web site", "login url"],
  username: ["username", "login_username", "user name", "login", "email"],
  password: ["password", "login_password"],
  title: ["title", "name"],
  type: ["type"],
} as const;

export function parsePasswordExport(text: string): ParsedPasswordExport {
  const table = parseCsv(text.replace(/^﻿/, ""));
  if (table === null) return { ok: false, error: "That file isn't a CSV Realm can read: a quoted field never ends." };
  const [head, ...body] = table;
  if (!head) return { ok: false, error: "That file is empty." };
  const names = head.map((h) => h.trim().toLowerCase());
  const col = (k: keyof typeof COLUMNS) => names.findIndex((n) => (COLUMNS[k] as readonly string[]).includes(n));
  const url = col("url"), password = col("password");
  if (url < 0 || password < 0) {
    return { ok: false, error: "That file has no URL and Password columns, so it isn't a password export Realm knows. Export again from Passwords, Chrome, 1Password or Bitwarden as CSV." };
  }
  const username = col("username"), title = col("title"), type = col("type");
  const rows: ImportedPassword[] = [];
  let skipped = 0;
  for (const cells of body) {
    // A blank line between records is not a record, and not a skipped one either.
    if (cells.every((c) => c.trim() === "")) continue;
    // Bitwarden exports notes, cards and identities beside logins; only a login is a sign-in.
    if (type >= 0 && (cells[type] ?? "").trim().toLowerCase() !== "login") { skipped++; continue; }
    const origin = siteOf(cells[url] ?? "");
    const value = cells[password] ?? "";
    if (!origin || value === "") { skipped++; continue; }
    rows.push({ origin, username: (cells[username] ?? "").trim(), password: value, title: (cells[title] ?? "").trim() });
  }
  return { ok: true, rows, skipped };
}

/**
 * The origin a row's address pins to. An export can hold a bare host ("example.com"), which is read as
 * https; an app's entry (`android://…`, `iosapp://…`) or anything else that is not a web address is
 * not a site, and the row is skipped. Bitwarden can list several addresses in one cell, comma
 * separated; the first is the one the user saved it at.
 */
function siteOf(cell: string): string | null {
  const first = cell.split(",")[0]!.trim();
  if (!first) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(first) ? first : `https://${first}`;
  return normalizeOrigin(withScheme);
}

/** RFC 4180: commas, CRLF or LF, fields in double quotes with "" for a quote. Null when a quote is
 *  left open at the end of the file. */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (quoted) return null;
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
