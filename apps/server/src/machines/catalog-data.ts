import type { QemuArch } from "./qemu-argv";

/**
 * The images Realm offers, pinned in the repo (Plan 25 W5).
 *
 * **Pinned, not fetched**, and the reason is the checksum: one fetched over the same channel as the
 * image verifies nothing at all — whoever could substitute the image could substitute the hash
 * beside it. Pinning makes the RELEASE the trust anchor, which is a thing the user already decided
 * to trust when they installed Realm.
 *
 * A network refresh may only EXTEND this list, through the `machine.catalog` settings cache, and
 * loses every id collision to the entry here. So a compromised or merely wrong feed can add an entry
 * nobody had, which the user still has to choose, and can never change one that shipped.
 *
 * The `sha256` fields are deliberately EMPTY in this release. An entry with no hash is offered as an
 * import rather than a download — see `catalog.ts` — because publishing a hash nobody verified would
 * be worse than publishing none: it would look like a guarantee. Filling them in is a release-time
 * job with the image in hand, not something to guess at from a distribution's own page.
 */
export type CatalogEntry = {
  id: string;
  name: string;
  /** What it is, in one line, for the picker. */
  summary: string;
  arch: QemuArch;
  /** Where the image or installer comes from. */
  url: string;
  /** Lowercase hex. Empty means "not verified in this release" — see the note above. */
  sha256: string;
  /** Rough download size, so a picker can say what it will cost before it starts. */
  bytes: number;
  /** `disk` boots straight from the image; `iso` is an installer that has to run first. */
  kind: "disk" | "iso";
  /** Sensible defaults for a guest of this kind. The user can change them. */
  memoryMb: number;
  cpus: number;
  diskGb: number;
};

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "debian-13-arm64",
    name: "Debian 13",
    summary: "A general-purpose Linux desktop. Installs from the ISO on first boot.",
    arch: "aarch64",
    url: "https://cdimage.debian.org/debian-cd/current/arm64/iso-cd/debian-13.0.0-arm64-netinst.iso",
    sha256: "",
    bytes: 600 * 1024 * 1024,
    kind: "iso",
    memoryMb: 4096, cpus: 4, diskGb: 40,
  },
  {
    id: "ubuntu-24-04-arm64",
    name: "Ubuntu 24.04 LTS",
    summary: "Ubuntu's long-term release, for arm64.",
    arch: "aarch64",
    url: "https://cdimage.ubuntu.com/releases/24.04/release/ubuntu-24.04-live-server-arm64.iso",
    sha256: "",
    bytes: 2600 * 1024 * 1024,
    kind: "iso",
    memoryMb: 4096, cpus: 4, diskGb: 40,
  },
  {
    id: "alpine-3-21-arm64",
    name: "Alpine 3.21",
    summary: "A very small Linux — boots in seconds, good for a throwaway shell.",
    arch: "aarch64",
    url: "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/aarch64/alpine-virt-3.21.0-aarch64.iso",
    sha256: "",
    bytes: 60 * 1024 * 1024,
    kind: "iso",
    memoryMb: 1024, cpus: 2, diskGb: 8,
  },
];

/**
 * Windows is deliberately absent, and this is the note rather than a catalog entry that fails.
 *
 * An ARM64 Windows guest needs an ISO Microsoft does not publish a stable direct link for, plus
 * virtio driver media loaded during setup. Neither is something a catalog can carry, and an entry
 * that downloaded something and then could not install it would be worse than not offering it.
 * macOS guests are out of scope entirely: Apple's licence and QEMU's capabilities both say no.
 */
export const CATALOG_ABSENT_NOTE =
  "Windows needs an ARM64 ISO you supply yourself plus virtio driver media, so Realm cannot offer it as a download — import the ISO instead. macOS guests are not possible here at all.";
