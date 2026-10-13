import type { PageDesignProps } from "@/components/lab/pages"
import { Cards } from "@/components/lab/page-inside/Cards"
import { Close } from "@/components/lab/page-inside/Close"
import { Film } from "@/components/lab/page-inside/Film"
import { Footer } from "@/components/lab/page-inside/Footer"
import { Ground } from "@/components/lab/page-inside/Ground"
import { Header } from "@/components/lab/page-inside/Header"
import css from "@/components/lab/page-inside/inside.module.css"
import { LightCanvas } from "@/components/lab/page-inside/LightCanvas"
import { Relay } from "@/components/lab/page-inside/Relay"

/**
 * Inside: the page is the app.
 *
 * The working sample of Realm is the stage. After the opening it stays pinned while the reader scrolls
 * a tour of chapters; each one puts the window in the state it describes, and a camera scrubbed by the
 * scroll moves in on the part of the window the sentence is about, with a hairline from the sentence
 * to it. Where the sample cannot show a thing, the same frame shows a capture of the shipped app,
 * labelled as one, and the tour ends by running the rest of the captures past the light. The window
 * is lit like a product on a set (studio.ts): a rim along the edges that face the light, its
 * reflection on the floor, and the light following it wherever the camera goes.
 *
 * On a phone or under reduced motion the same chapters are cards, each with its own cut of a capture,
 * and the sample sits in the page as a window you can click.
 *
 *   opening    the statement, the download, and the window on its floor
 *   tour       ten chapters in fifteen framings of the window, then the stills (Film.tsx)
 *   team       2.1's teams: roles handing work along, Review (Relay.tsx)
 *   ground     where the work lives, and the questions (Ground.tsx)
 *   close      the window shrinks into the app icon it ships as (Close.tsx)
 */
export default function Inside({ download, claims }: PageDesignProps) {
  return (
    <div className={`${css.page} min-h-[100dvh]`}>
      <LightCanvas />
      <Header download={download} />
      <main>
        <Film download={download} claims={claims} />
        <Cards claims={claims} />
        <Relay />
        <Ground />
        <Close download={download} />
      </main>
      <Footer download={download} />
    </div>
  )
}
