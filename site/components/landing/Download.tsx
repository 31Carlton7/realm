import { AppleIcon, LinuxIcon, WindowsIcon } from "@/components/icons"
import type { Downloads } from "@/lib/release"

import s from "./landing.module.css"

/**
 * The foot of the page: every build of the current release by name, each straight from the release
 * feed (lib/release), with what it is beside it. The hero's button offers the reader's own system;
 * this is where the others are.
 */
export function Download({ downloads, version, changelog }: { downloads: Downloads; version: string; changelog: string }) {
  const builds = [
    { href: downloads.mac, Icon: AppleIcon, name: "Mac", detail: "Apple silicon. Signed, notarized, and updates itself." },
    { href: downloads.windows, Icon: WindowsIcon, name: "Windows", detail: "x64 installer. A preview, not signed yet." },
    { href: downloads.linux, Icon: LinuxIcon, name: "Linux AppImage", detail: "x64, runs on any distribution. A preview." },
    { href: downloads.deb, Icon: LinuxIcon, name: "Linux deb", detail: "x64, installs with apt. A preview." },
  ]
  return (
    <section className={s.download} aria-labelledby="download-title">
      <div className={s.column}>
        <div className={s.claim}>
          <h2 className={s.h2} id="download-title">
            Download Realm
          </h2>
          <p className={s.body}>
            Free, and in active development.{" "}
            <a href={`/changelog/${changelog}`} className={s.inline}>
              What&apos;s new in <span className="font-mono text-[14px] text-accent-ink">{version}</span>
            </a>
          </p>
        </div>
        <ul className={s.builds}>
          {builds.map(({ href, Icon, name, detail }) => (
            <li key={name}>
              <a href={href} className={s.build}>
                <Icon className={s.buildIcon} />
                <span className={s.buildName}>{name}</span>
                <span className={s.buildDetail}>{detail}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
