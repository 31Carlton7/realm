import { encode } from "uqr";

/** The QR specification's quiet zone is four modules; a terminal's own margin is not light, so the
 *  code brings two of its own and gives way to fit a narrow window before it gives up error correction. */
const BORDER = 2;

/** Black on white whatever the terminal's colours: a code drawn light on dark is one that not every
 *  scanner reads (Settings ▸ Devices draws it the same way). 256-colour indexes, which every terminal
 *  that draws these blocks has, rather than the 16 a theme may have repainted. */
const INK = "\x1b[38;5;16;48;5;231m";
const RESET = "\x1b[0m";

/**
 * A pairing link as a QR code in a terminal: two modules to a character cell, top and bottom, using
 * the half blocks. A real link is 340-odd characters, a version 15 code at correction level M —
 * 81 columns with its border. Where the window is narrower it steps down to level L (73), which a
 * steady camera on a lit screen reads as well.
 */
export function terminalQr(text: string, o: { columns?: number; color?: boolean } = {}): string {
  const columns = o.columns ?? 80;
  let qr = encode(text, { ecc: "M", border: BORDER });
  if (qr.size > columns) qr = encode(text, { ecc: "L", border: BORDER });
  const dark = (x: number, y: number): boolean => qr.data[y]?.[x] === true;
  const lines: string[] = [];
  for (let y = 0; y < qr.size; y += 2) {
    let line = "";
    for (let x = 0; x < qr.size; x++) {
      const top = dark(x, y); const bottom = dark(x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(o.color === false ? line : `${INK}${line}${RESET}`);
  }
  return lines.join("\n");
}
