// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { PageField } from "@realm/contracts";
import { PAGE_FIELDS, readPageFields, type CdpSend } from "./browser-agent";

/**
 * What a page's card says about its form. What must die: a password's value, typed or shown with
 * "Show password", a one-time code, or a card's number or security code leaving the page; and a
 * page that answers with something of its own shape standing in for the read.
 */

const read = (): PageField[] => (0, eval)(PAGE_FIELDS) as PageField[];

afterEach(() => { document.body.innerHTML = ""; });

describe("a page's filled-in fields", () => {
  it("reads what a person typed, labelled, and hides every secret field's value", () => {
    document.body.innerHTML = `
      <label for="email">Email</label><input id="email" type="email" value="carlton@example.com">
      <label>Password <input id="pw" type="password" value="hunter2-secret"></label>
      <input id="shown" type="text" name="password" value="shown-secret">
      <input id="otp" autocomplete="one-time-code" value="123456">
      <input id="card" autocomplete="cc-number" placeholder="Card number" value="4242424242424242">
      <input id="cvc" name="cvc" value="737">
      <textarea aria-label="Note">ring twice</textarea>
      <select name="plan"><option>Free</option><option selected>Pro</option></select>
      <input type="checkbox" name="remember-password" checked>
      <input name="empty" value="">`;
    const fields = read();
    expect(fields).toEqual([
      { label: "Email", value: "carlton@example.com", hidden: false },
      { label: "Password", value: null, hidden: true },
      { label: "password", value: null, hidden: true },
      { label: "otp", value: null, hidden: true },
      { label: "Card number", value: null, hidden: true },
      { label: "cvc", value: null, hidden: true },
      { label: "Note", value: "ring twice", hidden: false },
      { label: "plan", value: "Pro", hidden: false },
    ]);
    // THE MUTANT: `type=password` alone — "Show password" made the field text, and its value left the page.
    const said = JSON.stringify(fields);
    for (const secret of ["hunter2-secret", "shown-secret", "123456", "4242424242424242", "737"]) expect(said).not.toContain(secret);
  });

  it("finds a field inside an open shadow root", () => {
    document.body.innerHTML = `<sign-in></sign-in>`;
    const shadow = document.querySelector("sign-in")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<input type="password" value="in-the-shadow"><input name="user" value="cai">`;
    expect(read()).toEqual([{ label: "", value: null, hidden: true }, { label: "user", value: "cai", hidden: false }]);
  });

  it("takes only an answer of its own shape: a page that claims a hidden field's value gets no fields", async () => {
    const answer = (value: unknown): CdpSend => (async () => ({ result: { value } })) as unknown as CdpSend;
    expect(await readPageFields(answer([{ label: "Email", value: "a@b.co", hidden: false }]))).toEqual([{ label: "Email", value: "a@b.co", hidden: false }]);
    expect(await readPageFields(answer([{ label: "Password", value: "leak", hidden: true }]))).toEqual([]);
    expect(await readPageFields(answer("nothing here"))).toEqual([]);
  });
});
