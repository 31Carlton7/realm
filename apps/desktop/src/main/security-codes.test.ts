import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { SECURITY_CODE_WAIT_MS, SECURITY_CODE_WINDOW_MS } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import {
  SecurityCodes, SecurityCodesSetting, codeSourcesFor, extractCode, fakeCodeSource, mailSource, messagesSource,
  missedCodeError, notificationsSource, parseMailList, pickLatestCode, textOfAttributedBody, type CodeMessage, type CodeSource,
} from "./security-codes";
import { bplist } from "./plist.test-fakes";

/**
 * The mutants:
 *   - a phone number, a date, a time, an amount or an order number read as the code;
 *   - a message older than the window offered;
 *   - a code bound to another site ("@other.com #123456") offered here;
 *   - a source read while the switch is off, or the switch on by default;
 *   - a harness build reading the owner's real Messages or Mail.
 */

const scratch = () => tempDir("realm-codes-");

describe("extractCode", () => {
  it.each([
    ["Your verification code is 482913", "482913"],
    ["482913 is your Instagram code. Don't share it.", "482913"],
    ["G-731904 is your Google verification code.", "731904"],
    ["Use 5520 to sign in to your account.", "5520"],
    ["Your one-time passcode: 093117 (expires in 10 minutes)", "093117"],
    ["Amazon: Your OTP is 618 204. Do not share.", "618204"],
    ["[Acme] Login code: K7Q2M9. Valid for 5 minutes.", "K7Q2M9"],
    ["Your Microsoft security code is 1234567", "1234567"],
    ["Subject: Confirm your email\nEnter 774201 to finish signing up.", "774201"],
  ])("finds the code in %j", (text, code) => {
    expect(extractCode(text)?.code).toBe(code);
  });

  it.each([
    ["Call us at (555) 123-4567 if you need help with your code.", "a phone number"],
    ["Your code was resent from +1 555 123 4567.", "a phone number in groups"],
    ["Your appointment is on 11/10/2026 at 10:30 am. Reply STOP to 55012 to opt out of codes.", "a date, a time and a short code"],
    ["Your order #1234567 has shipped. Track it with code below.", "an order number"],
    ["You paid $2499.00 with card ending 4821. Security alert.", "an amount and a card number"],
    ["See you on November 10, 2026 for the security review.", "a date in words"],
    ["The meeting is in room 4410. Bring your badge.", "a number with no cue"],
    ["Happy birthday! Lunch at 1200?", "no cue at all"],
  ])("finds none in %j (%s)", (text) => {
    expect(extractCode(text)).toBeNull();
  });

  it("keeps a code with a number elsewhere in the message", () => {
    expect(extractCode("Call 555-123-4567 for help. Your verification code is 902114.")?.code).toBe("902114");
  });

  it("binds a code to the site its origin-bound line names", () => {
    expect(extractCode("Your Example code is 123456.\n\n@example.com #123456")).toEqual({ code: "123456", site: "example.com" });
  });
});

describe("pickLatestCode", () => {
  const now = 10_000_000;
  const msg = (text: string, ago: number, source: CodeMessage["source"] = "Messages"): CodeMessage => ({ source, at: now - ago, text });

  it("offers the newest code inside the window, and nothing older", () => {
    const messages = [msg("Your code is 111111", 60_000), msg("Your code is 222222", 10_000, "Mail"), msg("Your code is 333333", SECURITY_CODE_WINDOW_MS + 1)];
    expect(pickLatestCode(messages, now, "https://example.com")).toEqual({ code: "222222", source: "Mail" });
    expect(pickLatestCode([msg("Your code is 333333", SECURITY_CODE_WINDOW_MS + 1)], now, "https://example.com")).toBeNull();
  });

  it("offers a message exactly at the window's edge and none past it", () => {
    expect(pickLatestCode([msg("Your code is 444444", SECURITY_CODE_WINDOW_MS)], now, "https://example.com")?.code).toBe("444444");
  });

  it("skips a code bound to another site for the next one", () => {
    const messages = [msg("code 555555\n@other.com #555555", 1_000), msg("Your code is 666666", 5_000)];
    expect(pickLatestCode(messages, now, "https://example.com")?.code).toBe("666666");
    expect(pickLatestCode(messages, now, "https://login.other.com")?.code).toBe("555555");
  });

  it("takes a code the source already found without searching its text", () => {
    expect(pickLatestCode([{ source: "Mail", at: now, text: "Welcome back", code: "A1B2C3" }], now, "https://example.com")?.code).toBe("A1B2C3");
  });
});

describe("SecurityCodes and its switch", () => {
  function spySource(messages: CodeMessage[]): CodeSource & { reads: number } {
    const s = { name: "Messages" as const, reads: 0, state: async () => "ok" as const, recent: async () => { s.reads++; return messages; } };
    return s;
  }

  it("is off by default, and off it reads no source", async () => {
    const setting = new SecurityCodesSetting(join(scratch(), "security-codes.json"));
    const source = spySource([{ source: "Messages", at: 1_000, text: "Your code is 123456" }]);
    const codes = new SecurityCodes({ setting, sources: [source], now: () => 1_000 });
    expect(setting.enabled()).toBe(false);
    expect(await codes.latest("https://example.com")).toBeNull();
    expect(await codes.status()).toEqual({ enabled: false, sources: null });
    expect(source.reads).toBe(0);
  });

  it("reads once turned on, and keeps the answer across a relaunch", async () => {
    const file = join(scratch(), "security-codes.json");
    const source = spySource([{ source: "Messages", at: 1_000, text: "Your code is 123456" }]);
    await new SecurityCodes({ setting: new SecurityCodesSetting(file), sources: [source], now: () => 1_000 }).setEnabled(true);
    const relaunched = new SecurityCodes({ setting: new SecurityCodesSetting(file), sources: [source], now: () => 1_000 });
    expect(await relaunched.latest("https://example.com")).toEqual({ code: "123456", source: "Messages" });
    expect(await relaunched.status()).toEqual({ enabled: true, sources: { Messages: "ok", Mail: "missing", Notifications: "missing" } });
  });

  it("treats a file that says anything but true as off", () => {
    const file = join(scratch(), "security-codes.json");
    writeFileSync(file, JSON.stringify({ enabled: "yes" }));
    expect(new SecurityCodesSetting(file).enabled()).toBe(false);
  });

  it("logs nothing while finding a code", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const setting = new SecurityCodesSetting(join(scratch(), "security-codes.json"));
    setting.setEnabled(true);
    const failing: CodeSource = { name: "Mail", state: async () => { throw new Error("Your code is 987654"); }, recent: async () => { throw new Error("Your code is 987654"); } };
    const codes = new SecurityCodes({ setting, sources: [spySource([{ source: "Messages", at: 1_000, text: "Your code is 987654" }]), failing], now: () => 1_000 });
    expect((await codes.latest("https://example.com"))?.code).toBe("987654");
    await codes.status();
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });
});

describe("SecurityCodes.waitFor", () => {
  /** A clock that only moves when the wait sleeps, and an inbox the test fills at a moment of its choosing. */
  function rig(o: { on?: boolean; arrive?: { at: number; message: CodeMessage }; mail?: CodeMessage[]; mailState?: "ok" | "no_access" } = {}) {
    let now = 1_000_000;
    const woke: string[] = [];
    const setting = { enabled: () => o.on ?? true, setEnabled: () => {} };
    const messages: CodeSource = {
      name: "Messages", state: async () => "ok",
      recent: async (since) => (o.arrive && now >= o.arrive.at ? [o.arrive.message] : []).filter((m) => m.at >= since),
    };
    const mail: CodeSource = { name: "Mail", state: async () => o.mailState ?? "ok", recent: async () => o.mail ?? [], wake: () => woke.push("Mail") };
    const sleeps: number[] = [];
    const codes = new SecurityCodes({
      setting, sources: [messages, mail], now: () => now,
      sleep: async (ms, signal) => { if (signal?.aborted) return; sleeps.push(ms); now += ms; },
    });
    return { codes, woke, sleeps };
  }

  it("waits for a code that arrives after the call, and wakes Mail first", async () => {
    const r = rig({ arrive: { at: 1_000_000 + 20_000, message: { source: "Messages", at: 1_000_000 + 20_000, text: "Your code is 482913" } } });
    expect(await r.codes.waitFor("https://example.com")).toEqual({ found: { code: "482913", source: "Messages" } });
    expect(r.woke).toEqual(["Mail"]);
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(20_000);
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(SECURITY_CODE_WAIT_MS);
  });

  it("gives up after the wait, saying which source was empty and why", async () => {
    const r = rig({ mail: [{ source: "Mail", at: 1_000_000 - 1_000, text: "Your receipt from Example" }] });
    const wait = await r.codes.waitFor("https://example.com");
    expect(wait).toEqual({ found: null, cancelled: false, miss: { Messages: "quiet", Mail: "no_code", Notifications: "missing" } });
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBe(SECURITY_CODE_WAIT_MS);
    const said = missedCodeError((wait as { miss: Parameters<typeof missedCodeError>[0] }).miss, SECURITY_CODE_WAIT_MS);
    expect(said).toMatch(/^no security code arrived in 90 s/);
    expect(said).toContain("Text Message Forwarding");
    expect(said).toContain("emails arrived in Mail, but none held a code");
    expect(said).not.toContain("receipt");
  });

  it("names a source Realm cannot read, and Mail not fetching", async () => {
    const r = rig({ mailState: "no_access" });
    const wait = await r.codes.waitFor("https://example.com", { timeoutMs: 5_000 });
    expect(wait).toMatchObject({ miss: { Messages: "quiet", Mail: "no_access" } });
    expect(missedCodeError({ Messages: "no_access", Mail: "quiet", Notifications: "ok" }, 90_000)).toMatch(/cannot read Messages \(Full Disk Access.*Mail may not be fetching/);
  });

  it("keeps the 5-minute window while it waits", async () => {
    const old = { source: "Messages" as const, at: 1_000_000 - SECURITY_CODE_WINDOW_MS - 1, text: "Your code is 111111" };
    const r = rig({ arrive: { at: 0, message: old } });
    expect(await r.codes.waitFor("https://example.com", { timeoutMs: 10_000 })).toMatchObject({ found: null });
  });

  it("stops at once when cancelled", async () => {
    const r = rig();
    const abort = new AbortController();
    abort.abort();
    expect(await r.codes.waitFor("https://example.com", { signal: abort.signal })).toEqual({ found: null, cancelled: true });
    expect(r.sleeps).toEqual([]);
  });

  it("off, wakes nothing and reads nothing", async () => {
    const r = rig({ on: false });
    expect(await r.codes.waitFor("https://example.com")).toMatchObject({ found: null });
    expect(r.woke).toEqual([]);
    expect(r.sleeps).toEqual([]);
  });

  it("stops a real sleep when cancelled mid-wait", async () => {
    const codes = new SecurityCodes({ setting: { enabled: () => true, setEnabled: () => {} }, sources: [], now: () => Date.now() });
    const abort = new AbortController();
    const t0 = Date.now();
    const wait = codes.waitFor("https://example.com", { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    expect(await wait).toEqual({ found: null, cancelled: true });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("the Messages source", () => {
  /** The columns Realm reads of chat.db's `message` table, as macOS lays them out. */
  function chatDb(rows: { text: string | null; body?: Uint8Array; at: number; fromMe?: boolean }[]): string {
    const path = join(scratch(), "chat.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER)");
    const insert = db.prepare("INSERT INTO message (text, attributedBody, date, is_from_me) VALUES (?, ?, ?, ?)");
    for (const r of rows) insert.run(r.text, r.body ?? null, BigInt(r.at - 978_307_200_000) * 1_000_000n, r.fromMe ? 1 : 0);
    db.close();
    return path;
  }
  /** A typedstream holding `text`, in the shape Messages writes. */
  const typedstream = (text: string) => {
    const words = Buffer.from(text, "utf8");
    return new Uint8Array(Buffer.concat([Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08", "latin1"), Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, words.length]), words, Buffer.from([0x86, 0x84])]));
  };

  it("reads incoming rows since the moment asked, from text or the typedstream", async () => {
    const now = Date.UTC(2026, 10, 10, 12);
    const path = chatDb([
      { text: "Your code is 111111", at: now - 10 * 60_000 },
      { text: null, body: typedstream("Your code is 222222"), at: now - 60_000 },
      { text: "My code is 333333", at: now - 30_000, fromMe: true },
    ]);
    const rows = await messagesSource(path).recent(now - SECURITY_CODE_WINDOW_MS);
    expect(rows).toEqual([{ source: "Messages", at: now - 60_000, text: "Your code is 222222" }]);
    expect(await messagesSource(path).state()).toBe("ok");
  });

  it("reads a long typedstream's 16-bit length", () => {
    const long = `Your code is 424242. ${"x".repeat(300)}`;
    const words = Buffer.from(long);
    const blob = Buffer.concat([Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, 0x81, words.length & 0xff, words.length >> 8]), words]);
    expect(textOfAttributedBody(new Uint8Array(blob))).toBe(long);
  });

  it("says a missing database is missing", async () => {
    expect(await messagesSource(join(scratch(), "chat.db")).state()).toBe("missing");
  });
});

describe("the Notifications source", () => {
  const now = Date.UTC(2026, 10, 10, 12);
  /** Notification Center's tables as `usernoted` creates them on macOS 27, holding synthetic rows. */
  function notificationDb(rows: { data: Uint8Array | null; at: number }[]): string {
    const path = join(scratch(), "db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE dbinfo (key VARCHAR, value VARCHAR);
      CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier VARCHAR, badge INTEGER NULL);
      CREATE TABLE record (rec_id INTEGER PRIMARY KEY, app_id INTEGER, uuid BLOB, data BLOB, request_date REAL, request_last_date REAL, delivered_date REAL, presented Bool, style INTEGER, snooze_fire_date REAL);
      CREATE TABLE requests (app_id INTEGER PRIMARY KEY, list BLOB);
      CREATE TABLE delivered (app_id INTEGER PRIMARY KEY, list BLOB);
      CREATE TABLE displayed (app_id INTEGER PRIMARY KEY, list BLOB);
      CREATE TABLE categories (app_id INTEGER PRIMARY KEY, categories BLOB);
      INSERT INTO app (app_id, identifier) VALUES (1, 'com.example.app');
    `);
    const insert = db.prepare("INSERT INTO record (app_id, data, request_date, delivered_date, presented, style) VALUES (1, ?, ?, ?, 1, 1)");
    for (const r of rows) {
      const seconds = (r.at - 978_307_200_000) / 1000;
      insert.run(r.data, seconds, seconds);
    }
    db.close();
    return path;
  }
  const note = (req: Record<string, string>) => bplist({ app: "com.example.app", req });

  it("reads the title, subtitle and body of notifications delivered since the moment asked, newest first", async () => {
    const path = notificationDb([
      { data: note({ titl: "Example", body: "Your code is 111111" }), at: now - 10 * 60_000 },
      { data: note({ titl: "Example", subt: "Sign in", body: "Your code is 222222" }), at: now - 90_000 },
      { data: note({ titl: "+1 (555) 010-0000", body: "Your verification code is 333333" }), at: now - 30_000 },
    ]);
    expect(await notificationsSource(path).recent(now - SECURITY_CODE_WINDOW_MS)).toEqual([
      { source: "Notifications", at: now - 30_000, text: "+1 (555) 010-0000\nYour verification code is 333333" },
      { source: "Notifications", at: now - 90_000, text: "Example\nSign in\nYour code is 222222" },
    ]);
    expect(await notificationsSource(path).state()).toBe("ok");
  });

  it("reads a row without a request, or whose data is not a plist, as no words", async () => {
    const path = notificationDb([{ data: bplist({ app: "com.example.app" }), at: now - 1_000 }, { data: new Uint8Array([1, 2, 3]), at: now - 2_000 }, { data: null, at: now - 3_000 }]);
    expect((await notificationsSource(path).recent(now - SECURITY_CODE_WINDOW_MS)).map((r) => r.text)).toEqual(["", "", ""]);
  });

  it("hands the newest code to a fill, named as a notification's", async () => {
    const setting = new SecurityCodesSetting(join(scratch(), "security-codes.json"));
    setting.setEnabled(true);
    const path = notificationDb([{ data: note({ titl: "Example", body: "Your code is 123456" }), at: now - 60_000 }]);
    const codes = new SecurityCodes({ setting, sources: [notificationsSource(path)], now: () => now });
    expect(await codes.latest("https://example.com")).toEqual({ code: "123456", source: "Notifications" });
  });

  it("says a missing database is missing", async () => {
    expect(await notificationsSource(join(scratch(), "db")).state()).toBe("missing");
  });
});

describe("the Mail source", () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const iso = (ago: number) => new Date(now - ago).toISOString();

  it("keeps rows inside the window and asks extract only where the preview has no code", async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args[1] === "list") return { code: 0, stdout: JSON.stringify([
        { id: "a", subject: "Your sign-in code", summary: "Enter 551200 to sign in", date: iso(30_000) },
        { id: "b", subject: "Confirm it's you", summary: "Open this email for your code", date: iso(60_000) },
        { id: "c", subject: "Your code is 999999", summary: "", date: iso(SECURITY_CODE_WINDOW_MS + 60_000) },
      ]) };
      return { code: 0, stdout: JSON.stringify({ codes: [{ code: "77AB12", confidence: "high", context: "" }] }) };
    };
    const rows = await mailSource(run).recent(now - SECURITY_CODE_WINDOW_MS);
    expect(rows.map((r) => [r.at, r.code])).toEqual([[now - 30_000, undefined], [now - 60_000, "77AB12"]]);
    expect(calls.filter((c) => c[1] === "extract").map((c) => c[2])).toEqual(["b"]);
    expect(calls[0]).toContain("newer:1d");
  });

  it("drops a row whose date will not parse", () => {
    expect(parseMailList(JSON.stringify([{ id: "a", subject: "code 123456", date: "yesterday" }]))).toEqual([]);
  });

  it("is missing with no mac command, and denied when mac says permission was refused", async () => {
    expect(await mailSource(null).state()).toBe("missing");
    expect(await mailSource(async () => ({ code: 2, stdout: "" })).state()).toBe("no_access");
  });
});

describe("codeSourcesFor", () => {
  it("gives a harness build the stand-in file or nothing, never the real sources", async () => {
    expect(codeSourcesFor({ packaged: false, env: { REALM_ENABLE_FAKE_AGENT: "1" } })).toEqual([]);
    const file = join(scratch(), "codes.json");
    writeFileSync(file, JSON.stringify([{ source: "Mail", at: 5_000, text: "Your code is 123456" }]));
    const sources = codeSourcesFor({ packaged: false, env: { REALM_ENABLE_FAKE_AGENT: "1", REALM_LIVE_CODES: file } });
    expect(sources.map((s) => s.name)).toEqual(["Messages", "Mail", "Notifications"]);
    expect(await sources[1]!.recent(0)).toEqual([{ source: "Mail", at: 5_000, text: "Your code is 123456" }]);
    expect(await sources[0]!.recent(0)).toEqual([]);
  });

  it("gives a packaged build Messages, Mail and Notifications", () => {
    expect(codeSourcesFor({ packaged: true, env: {} }).map((s) => s.name)).toEqual(["Messages", "Mail", "Notifications"]);
  });

  it("reads a rewritten stand-in file on the next ask", async () => {
    const file = join(scratch(), "codes.json");
    const source = fakeCodeSource("Messages", file);
    expect(await source.recent(0)).toEqual([]);
    writeFileSync(file, JSON.stringify([{ source: "Messages", at: 9, text: "code 123456" }]));
    expect(await source.recent(0)).toHaveLength(1);
  });
});
