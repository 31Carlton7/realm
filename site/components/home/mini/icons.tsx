/**
 * The glyphs the in-page Realm draws, at the app's 16-unit grid and its stroke weight. Drawn here
 * rather than taken from the app's icon set, which is a private registry the site cannot install
 * (README, "Why it is not in the pnpm workspace"). Each is a stroke in the text's colour.
 */
type IconProps = { className?: string }

const paths = {
  home: "M2.5 7.2 8 2.8l5.5 4.4V13a.7.7 0 0 1-.7.7H9.6V10H6.4v3.7H3.2a.7.7 0 0 1-.7-.7Z",
  book: "M8 4.2C6.7 3.2 5 2.8 2.5 2.9v9.4c2.5-.1 4.2.3 5.5 1.3m0-9.4c1.3-1 3-1.4 5.5-1.3v9.4c-2.5-.1-4.2.3-5.5 1.3m0-9.4v9.4",
  plug: "M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0Zm3.5 5.7v2.3",
  clock: "M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Zm0 2.7V8l2 1.3",
  pr: "M4.5 5.2v5.6M4.5 5.2a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 5.6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm0 0V6.5a2 2 0 0 0-2-2H7.3m1.5-1.6L7.2 4.5l1.6 1.6",
  folder: "M2.5 4.3c0-.5.4-.8.8-.8h3l1.4 1.5h5c.5 0 .8.4.8.8v6.4c0 .5-.3.8-.8.8H3.3a.8.8 0 0 1-.8-.8Z",
  grid: "M3 3h4v4H3Zm6 0h4v4H9ZM3 9h4v4H3Zm6 0h4v4H9Z",
  globe: "M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11ZM2.5 8h11M8 2.5c1.5 1.6 2.2 3.4 2.2 5.5S9.5 11.9 8 13.5C6.5 11.9 5.8 10.1 5.8 8S6.5 4.1 8 2.5Z",
  notebook: "M4 2.5h7.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4Zm0 0v11M6.5 5.5h3.5",
  chat: "M3 4a1.2 1.2 0 0 1 1.2-1.2h7.6A1.2 1.2 0 0 1 13 4v5.6a1.2 1.2 0 0 1-1.2 1.2H7l-2.8 2.4v-2.4A1.2 1.2 0 0 1 3 9.6Z",
  chevronDown: "m5 6.5 3 3 3-3",
  chevronRight: "m6.5 5 3 3-3 3",
  chevronLeft: "m9.5 5-3 3 3 3",
  sidebar: "M3 3.5h10a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Zm3 0v9",
  search: "M7.2 3a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4Zm3 7.2L13 13",
  compose: "M8.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7.5M7 9l.4-1.9 4.5-4.5a1.1 1.1 0 0 1 1.5 1.5L8.9 8.6Z",
  terminal: "M2.5 3.5h11v9h-11Zm2.5 3 2 1.5-2 1.5m3.5.5h2.5",
  doc: "M4 2.5h5l3 3v8H4Zm5 0v3h3",
  agents: "M5.5 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm5.5 1.5a1.7 1.7 0 1 0 0-3.4A1.7 1.7 0 0 0 11 8ZM2 13c.3-2.2 1.7-3.6 3.5-3.6S8.7 10.8 9 13m.5-3.6c.4-.3.9-.4 1.5-.4 1.5 0 2.6 1.1 3 3",
  diff: "M5 2.5v6M2 5.5h6M2.5 11.5h6M10.5 4.5h3m-3 3h3m-3 3h3",
  shield: "M8 2.5 3.5 4.2v3.5c0 2.8 1.9 4.9 4.5 5.8 2.6-.9 4.5-3 4.5-5.8V4.2Z",
  arrowUp: "M8 12.5v-9M4.5 7 8 3.5 11.5 7",
  plus: "M8 3.5v9M3.5 8h9",
  branch: "M5 3v10M5 6.5c0 2 1.5 2.5 3.5 2.5H11M11 6.5a1.5 1.5 0 1 0 0 3",
  undo: "M5 6h5.5a2.5 2.5 0 0 1 0 5H8M5 6l2-2M5 6l2 2",
  check: "m3.5 8.3 2.8 2.7 6.2-6.5",
  close: "m4.5 4.5 7 7m0-7-7 7",
  laptop: "M3.5 4h9v6h-9Zm-1.5 7.5h12",
  device: "M5 2.5h6a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm2 9h2",
  reload: "M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10",
  more: "M4 8h.01M8 8h.01M12 8h.01",
  spark: "M8 2.5v11M2.5 8h11M4.1 4.1l7.8 7.8m0-7.8-7.8 7.8",
} as const

export type IconName = keyof typeof paths

export function Icon({ name, className }: IconProps & { name: IconName }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={className ?? "h-4 w-4"}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  )
}
