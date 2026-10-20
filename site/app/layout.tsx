import type { Metadata, Viewport } from "next"
import { Inter, JetBrains_Mono } from "next/font/google"

import { Passage } from "@/components/passage/Passage"
import { PointerLight } from "@/components/PointerLight"
import { site } from "@/lib/site"

import "./globals.css"

// The same two faces the desktop app bundles, so the site and the product set type identically.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" })
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL(`https://${site.domain}`),
  title: { default: `${site.name}: ${site.tagline}`, template: `%s · ${site.name}` },
  description: site.description,
  openGraph: {
    type: "website",
    siteName: site.name,
    title: `${site.name}: ${site.tagline}`,
    description: site.description,
  },
  twitter: { card: "summary_large_image", title: site.name, description: site.description },
  // Drawn by scripts/render-icons.mjs. The one-colour mark follows the browser's colour scheme;
  // app/favicon.ico, added by file name, is the fallback for browsers that do not read SVG.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon.png", sizes: "180x180" }],
    other: [{ rel: "mask-icon", url: "/mask-icon.svg", color: "#3b7cf0" }],
  },
}

export const viewport: Viewport = {
  themeColor: "#17181a",
  colorScheme: "dark",
}

/**
 * Names the reader's system on the root before the first paint, so every download on the page is the
 * build for it from the first frame (components/Buttons.tsx, globals.css). Android's and ChromeOS's
 * agents say Linux too, and an iPhone's say Mac; none of them gets a Linux build, so they are left
 * unnamed and see the Mac's.
 */
const NAME_OS = `try{var n=navigator,p=((n.userAgentData&&n.userAgentData.platform)||n.platform||"")+" "+n.userAgent,os=/Android|CrOS|iPhone|iPad/.test(p)?"":/Win/.test(p)?"windows":/Linux|X11/.test(p)?"linux":"";if(os)document.documentElement.dataset.os=os}catch(e){}`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The script above sets an attribute React did not render; that difference is the point.
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NAME_OS }} />
      </head>
      <body className="font-sans antialiased">
        {children}
        <Passage />
        <PointerLight />
      </body>
    </html>
  )
}
