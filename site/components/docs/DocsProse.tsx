import { Figure } from "@/components/changelog/Figure"
import { Screen } from "@/components/realms/Screen"
import { headings, type Block, type Shot } from "@/lib/docs"
import { partImage, sceneImage } from "@/lib/pictures"
import crops from "@/public/docs/crops.json"

import { CopyButton } from "./CopyButton"
import styles from "./docs.module.css"
import { inline } from "./inline"

/**
 * A docs page's body, block by block. Heads carry the ids `headings` gives them, so the outline built
 * from the same blocks links to them.
 */
export function DocsProse({ blocks }: { blocks: Block[] }) {
  const ids = new Map(headings(blocks).map((heading) => [heading.index, heading.id]))
  return (
    <div className={styles.prose}>
      {blocks.map((block, key) => {
        switch (block.kind) {
          case "p":
            return <p key={key}>{inline(block.text)}</p>
          case "h2":
          case "h3": {
            const id = ids.get(key)
            const Head = block.kind
            return (
              <Head key={key} id={id}>
                <a href={`#${id}`}>{inline(block.text)}</a>
              </Head>
            )
          }
          case "ul":
            return (
              <ul key={key}>
                {block.items.map((item, index) => (
                  <li key={index}>{inline(item)}</li>
                ))}
              </ul>
            )
          case "steps":
            return (
              <ol key={key} className={styles.steps}>
                {block.items.map((item, index) => (
                  <li key={index}>{inline(item)}</li>
                ))}
              </ol>
            )
          case "code":
            return (
              <div key={key} className={styles.code}>
                {block.label ? (
                  <div className={styles.codeHead}>
                    <span>{block.label}</span>
                    <CopyButton text={block.text} />
                  </div>
                ) : (
                  <CopyButton text={block.text} />
                )}
                <pre>
                  <code>{block.text}</code>
                </pre>
              </div>
            )
          case "callout":
            return (
              <div key={key} role="note" data-tone={block.tone} className={styles.callout}>
                <span>{block.tone === "note" ? "Note" : block.tone === "tip" ? "Tip" : "Careful"}</span>
                {inline(block.text)}
              </div>
            )
          case "table":
            return (
              <div key={key} className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      {block.head.map((cell, index) => (
                        <th key={index} scope="col">
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case "figure":
            return <DocFigure key={key} shot={block.shot} alt={block.alt} caption={inline(block.caption)} />
        }
      })}
    </div>
  )
}

const SIZES = "(min-width: 1024px) 704px, 100vw"

/** A capture, shown as the rest of the site shows one (components/realms/Screen): a whole window, a
 *  part of one photographed on its own, or a crop. A crop is drawn no larger than it is in the app. */
function DocFigure({ shot, alt, caption }: { shot: Shot; alt: string; caption: React.ReactNode }) {
  if ("detail" in shot) return <Figure image={shot.detail} alt={alt} caption={caption} />
  if ("crop" in shot) {
    const crop = (crops as Record<string, { width: number; height: number; radius: number }>)[shot.crop]
    if (!crop) return null
    return <Screen image={{ src: `/docs/${shot.crop}.webp`, ...crop }} alt={alt} caption={caption} zoom={1} sizes={SIZES} />
  }
  if ("part" in shot) {
    const image = partImage(shot.part)
    return image ? <Screen image={image} alt={alt} caption={caption} zoom={1} sizes={SIZES} /> : null
  }
  return <Screen kind="window" image={sceneImage(shot.scene)} alt={alt} caption={caption} zoom={1} sizes={SIZES} />
}
