// The oldest macOS a helper binary or an app's Info.plist says it runs on.

const MH_MAGIC_64 = 0xfeedfacf;
const LC_VERSION_MIN_MACOSX = 0x24;
const LC_BUILD_VERSION = 0x32;

/** "13.0" → 130000, so versions compare as numbers. */
export function versionNumber(version) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major * 10_000 + minor * 100 + patch;
}

/** The macOS a thin 64-bit Mach-O says it needs, as "13.0", or null when it carries no version command. */
export function minimumMacos(bytes) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== MH_MAGIC_64) throw new Error("not a thin 64-bit Mach-O");
  const commands = bytes.readUInt32LE(16);
  let at = 32;
  for (let i = 0; i < commands; i++) {
    const cmd = bytes.readUInt32LE(at);
    if (cmd === LC_BUILD_VERSION || cmd === LC_VERSION_MIN_MACOSX) {
      const v = bytes.readUInt32LE(at + (cmd === LC_BUILD_VERSION ? 12 : 8));
      const patch = v & 0xff;
      return `${v >>> 16}.${(v >>> 8) & 0xff}${patch ? `.${patch}` : ""}`;
    }
    at += bytes.readUInt32LE(at + 4);
  }
  return null;
}

/** The LSMinimumSystemVersion an XML Info.plist declares, or null. */
export function plistMinimumMacos(xml) {
  return /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1] ?? null;
}
