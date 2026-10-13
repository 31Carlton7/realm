import { Inter } from "next/font/google"

/**
 * Inter with its optical-size axis as well as its weight. The site loads Inter's weights only, which
 * sets a 120px headline with the spacing and apertures drawn for 14px text; with `opsz` the browser
 * picks Inter Display at display sizes on its own (`font-optical-sizing: auto`). Same family, the cut
 * a typographer would choose for the size.
 */
export const paperInter = Inter({ subsets: ["latin"], axes: ["opsz"], variable: "--font-paper", display: "swap" })
