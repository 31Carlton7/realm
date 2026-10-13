/**
 * PDFs written by hand for the PDF viewer's live check (pdf-view-live.mjs), each one aimed at a part
 * of pdf.js that only runs in the built app: the standard fonts (text in a font the file does not
 * embed), the CMaps (Japanese in a predefined CMap), the JPX decoder (a scanned-style picture), the
 * password path and the corrupt path. Nothing here is a general PDF writer; it writes exactly these.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Objects in, a PDF out. `objs[i]` is object i+1, as a string or a { dict, stream } pair. */
function writePdf(objs, { root = 1, encrypt = null } = {}) {
  const parts = ["%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"];
  const offsets = [];
  let length = Buffer.byteLength(parts[0], "latin1");
  const push = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1"); parts.push(b); length += b.length; };
  objs.forEach((o, i) => {
    offsets.push(length);
    if (typeof o === "string") { push(`${i + 1} 0 obj\n${o}\nendobj\n`); return; }
    let data = Buffer.isBuffer(o.stream) ? o.stream : Buffer.from(o.stream, "latin1");
    if (encrypt) data = encrypt.stream(i + 1, data);
    push(`${i + 1} 0 obj\n<< ${o.dict} /Length ${data.length} >>\nstream\n`);
    push(data);
    push("\nendstream\nendobj\n");
  });
  const xref = length;
  let table = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) table += `${String(off).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${objs.length + 1} /Root ${root} 0 R${encrypt ? ` /Encrypt ${encrypt.ref} 0 R /ID [<${encrypt.id}> <${encrypt.id}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "latin1"))));
}

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * `pages` pages of Helvetica text — a font the file does NOT embed, so it is drawn from pdf.js's
 * standard font data. Page 1 carries a link to page `linkTo` and one out to example.com; a word
 * find can count ("lighthouse") is on every fifth page; page 3 is landscape, like a slide.
 */
export function textPdf(pages = 40, linkTo = 30) {
  const objs = [];
  const add = (o) => { objs.push(o); return objs.length; };
  add(""); add(""); add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"); add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const kids = [];
  const pageIds = [];
  for (let n = 1; n <= pages; n++) {
    const landscape = n === 3;
    const [w, h] = landscape ? [792, 612] : [612, 792];
    const lines = [`BT /F2 28 Tf 72 ${h - 96} Td (${esc(`Page ${n} of ${pages}`)}) Tj ET`];
    const body = [
      "Realm draws this PDF itself, with pdf.js, on the pane's own ground.",
      "Every line here is real text that can be selected and copied.",
      "The quick brown fox jumps over the lazy dog, again and again.",
    ];
    for (let k = 0; k < 24; k++) {
      const line = n % 5 === 0 && k === 10 ? `The lighthouse on page ${n} is a word find can count.` : body[k % body.length];
      lines.push(`BT /F1 12 Tf 72 ${h - 140 - k * 20} Td (${esc(line)}) Tj ET`);
    }
    if (n === 1) {
      lines.push(`BT /F1 14 Tf 0 0.3 0.8 rg 72 120 Td (Go to page ${linkTo}) Tj ET`);
      lines.push(`BT /F1 14 Tf 0 0.3 0.8 rg 300 120 Td (example.com) Tj ET`);
    }
    const content = add({ dict: "", stream: lines.join("\n") });
    const id = add("");
    pageIds.push({ id, content, w, h, n });
    kids.push(`${id} 0 R`);
  }
  for (const p of pageIds) {
    const annots = p.n === 1 ? ` /Annots [${objs.length + 1} 0 R ${objs.length + 2} 0 R]` : "";
    objs[p.id - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${p.content} 0 R${annots} >>`;
    if (p.n === 1) {
      const target = pageIds[Math.min(linkTo, pages) - 1];
      add(`<< /Type /Annot /Subtype /Link /Rect [70 112 220 138] /Border [0 0 0] /Dest [${target.id} 0 R /XYZ 0 ${target.h} 0] >>`);
      add(`<< /Type /Annot /Subtype /Link /Rect [298 112 400 138] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >> >>`);
    }
  }
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  return writePdf(objs);
}

/** Japanese set in a font the file does not carry, through the predefined UniJIS-UCS2-H CMap: pdf.js
 *  needs its CMap files to read a single character of it. */
export function cjkPdf() {
  const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16).padStart(4, "0")).join("").toUpperCase();
  const lines = ["日本語の文書です。", "灯台は岬の先に立っている。", "東京、大阪、京都、札幌。"];
  const content = lines.map((l, i) => `BT /F1 28 Tf 72 ${680 - i * 56} Td <${hex(l)}> Tj ET`).join("\n")
    + "\nBT /F2 14 Tf 72 480 Td (Latin text beside it: CMaps loaded.) Tj ET";
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 8 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: content },
    "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> /FontDescriptor 7 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /KozMinPr6N-Regular /Flags 6 /FontBBox [-437 -340 1147 1317] /ItalicAngle 0 /Ascent 1317 /Descent -349 /CapHeight 742 /StemV 80 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

/** A page that is one JPEG 2000 picture, as a scanner writes them — drawn only by pdf.js's JPX
 *  decoder, which is WASM. Needs `opj_compress` (Homebrew's openjpeg); null without it. */
export function jpxPdf() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "realm-jpx-"));
  const [w, h] = [600, 400];
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const inBox = x > 150 && x < 450 && y > 100 && y < 300;
    px[i] = inBox ? 220 : Math.round((x / w) * 255);
    px[i + 1] = inBox ? 40 : Math.round((y / h) * 255);
    px[i + 2] = inBox ? 40 : 160;
  }
  const ppm = path.join(dir, "in.ppm"), j2k = path.join(dir, "out.j2k");
  fs.writeFileSync(ppm, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), px]));
  try { execFileSync("opj_compress", ["-i", ppm, "-o", j2k], { stdio: "ignore" }); } catch { return null; }
  const jpx = fs.readFileSync(j2k);
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: "q 468 0 0 312 72 400 cm /Im1 Do Q" },
    { dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode`, stream: jpx },
  ]);
}

/** One page under the standard security handler (RC4, 40-bit) with a user password, so nothing in it
 *  can be read without one. */
export function passwordPdf(password = "secret") {
  const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
  const padded = (s) => Buffer.concat([Buffer.from(s, "latin1"), PAD]).subarray(0, 32);
  // RC4 by hand: Node's OpenSSL 3 no longer ships it.
  const rc4 = (key, data) => {
    const S = [...Array(256).keys()];
    for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
    const out = Buffer.alloc(data.length);
    for (let n = 0, i = 0, j = 0; n < data.length; n++) {
      i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]];
      out[n] = data[n] ^ S[(S[i] + S[j]) & 255];
    }
    return out;
  };
  const md5 = (...b) => createHash("md5").update(Buffer.concat(b)).digest();
  const id = createHash("md5").update("realm-password-fixture").digest();
  const P = -44;
  const O = rc4(md5(padded("owner")).subarray(0, 5), padded(password));
  const pBytes = Buffer.alloc(4); pBytes.writeInt32LE(P);
  const key = md5(padded(password), O, pBytes, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const objKey = (n) => md5(key, Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0])).subarray(0, 10);
  const encrypt = { ref: 6, id: id.toString("hex"), stream: (n, data) => rc4(objKey(n), data) };
  return writePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    { dict: "", stream: "BT /F1 24 Tf 72 700 Td (Behind a password.) Tj ET" },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${P} >>`,
  ], { encrypt });
}

/** Not a PDF at all, under a name that says it is. */
export function corruptPdf() {
  return Buffer.from("%PDF-1.7\nthis file was cut off before any of its objects were written\n");
}
