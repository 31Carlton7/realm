/** A minimal `bplist00` writer — enough to stand in for what `plutil -convert binary1` writes. */
export function bplist(root: unknown): Uint8Array {
  const objects: number[][] = [];
  const header = (marker: number, n: number) => (n < 15 ? [marker | n] : [marker | 0x0f, 0x10, n]);
  const add = (v: unknown): number => {
    const at = objects.length;
    objects.push([]);
    let bytes: number[];
    if (typeof v === "boolean") bytes = [v ? 0x09 : 0x08];
    else if (typeof v === "number") bytes = [0x11, (v >> 8) & 0xff, v & 0xff];
    else if (typeof v === "string") {
      if (/^[\x00-\x7f]*$/.test(v)) bytes = [...header(0x50, v.length), ...[...v].map((c) => c.charCodeAt(0))];
      else bytes = [...header(0x60, v.length), ...[...v].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])];
    } else if (Array.isArray(v)) {
      const refs = v.map(add);
      bytes = [...header(0xa0, refs.length), ...refs];
    } else {
      const entries = Object.entries(v as Record<string, unknown>);
      const keys = entries.map(([k]) => add(k));
      const vals = entries.map(([, x]) => add(x));
      bytes = [...header(0xd0, entries.length), ...keys, ...vals];
    }
    objects[at] = bytes;
    return at;
  };
  add(root);
  const out: number[] = [...Buffer.from("bplist00")];
  const offsets: number[] = [];
  for (const o of objects) { offsets.push(out.length); out.push(...o); }
  const table = out.length;
  for (const off of offsets) out.push((off >> 8) & 0xff, off & 0xff);
  const u64 = (n: number) => [0, 0, 0, 0, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  out.push(0, 0, 0, 0, 0, 0, 2, 1, ...u64(objects.length), ...u64(0), ...u64(table));
  return Uint8Array.from(out);
}
