/**
 * A session's tool, opened the way a person opens one now that the session's bar carries none of
 * them: from its side pane's "+" when it has a side pane, else with ⌘⇧B, which makes one on a new tab
 * whose page lists the tools — then that page's row. Needs REALM_HTML_MENUS=1, so the "+" menu is
 * drawn in the page where CDP can click it.
 *
 * `c` is a CDP client (`send`); `title` names the session's pane, or null for the first session on
 * screen; `tool` is a row's label —
 * "Documents", "Terminal", "Agents", "Simulator", "Machine" — or "New tab" for a page. The terminal
 * a new tab's page makes is a fresh shell, where the "+" goes to the session's own (⌘J): a check
 * about that difference presses ⌘J itself.
 *
 * Resolves to how the tool was reached: "plus" or "page".
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(c, expression) {
  const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(100);
  }
}

/** The session's pane, and the side pane serving it — the second panel of its own column's group. */
const PANES = (title) => `const panels = [...document.querySelectorAll('.panehost .panel')];
  const title = ${JSON.stringify(title)};
  const pane = panels.find((p) => !p.hasAttribute('data-tabbed') && (title === null ? !!p.querySelector(':scope > .panel-bar .panel-crumb')
    : p.querySelector(':scope > .panel-bar .panel-title')?.textContent === title));
  const group = (el) => el?.parentElement?.closest('[data-panel-group]') ?? null;
  const side = pane ? panels.find((p) => p.hasAttribute('data-tabbed') && group(p) === group(pane)) ?? null : null;`;

export async function openSideTool(c, title, tool) {
  const how = await evaluate(c, `(() => { ${PANES(title)}
    if (!pane) return null;
    if (side) { side.querySelector('.pane-tabs-add').click(); return "plus"; }
    // The keyboard in the session, and out of its prompter, where ⌘⇧B would be typing.
    pane.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.activeElement?.blur?.();
    return "page"; })()`);
  if (!how) throw new Error(`no pane for ${title ?? "a session"}`);
  if (how === "plus") {
    await until(() => evaluate(c, `(() => { const row = [...document.querySelectorAll('.menu[aria-label="New tab"] [role^=menuitem]')]
      .find((r) => r.querySelector('.menu-label')?.textContent === ${JSON.stringify(tool)}); if (!row) return false; row.click(); return true; })()`), 5_000, `${tool} in the + menu`);
    return how;
  }
  for (const type of ["keyDown", "keyUp"]) {
    await c.send("Input.dispatchKeyEvent", { type, modifiers: 4 | 8, key: "B", code: "KeyB", windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66 });
  }
  await until(() => evaluate(c, `(() => { ${PANES(title)} return !!side?.querySelector('.new-tab'); })()`), 10_000, `a new tab beside ${title ?? "the session"}`);
  if (tool !== "New tab") {
    await until(() => evaluate(c, `(() => { ${PANES(title)} const row = [...(side?.querySelectorAll('.new-tab-row') ?? [])]
      .find((r) => r.querySelector('.new-tab-row-label')?.textContent === ${JSON.stringify(tool)}); if (!row) return false; row.click(); return true; })()`), 5_000, `${tool} on the new-tab page`);
    // The tool takes the blank tab's place; until it has, the strip still shows the page.
    await until(() => evaluate(c, `(() => { ${PANES(title)} return !side?.querySelector('.new-tab'); })()`), 15_000, `${tool} in the blank tab's place`);
  }
  return how;
}
