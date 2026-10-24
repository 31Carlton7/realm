// cdp_shot.mjs <devtools port> <out.png>: screenshot the first page target over the Chrome DevTools Protocol.
import { writeFileSync } from "node:fs";
const [port, out] = process.argv.slice(2);
const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page");
if (!pages.length) { console.error("no page target"); process.exit(1); }
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
const m = await new Promise((r) => ws.addEventListener("message", (e) => { const d = JSON.parse(e.data); if (d.id === 1) r(d); }));
writeFileSync(out, Buffer.from(m.result.data, "base64")); console.log(`${out} (${pages[0].url.split("?")[0].slice(-40)})`); ws.close();
