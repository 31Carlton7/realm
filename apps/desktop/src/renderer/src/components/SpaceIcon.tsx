import DOMPurify from "dompurify";
import { parseSpaceIcon } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useMemo } from "react";
import { useApp } from "../state/store";

/**
 * Renders a `Space.icon` string regardless of which of the four sources it names — built-in glyph,
 * emoji, or a saved `IconAsset` (upload or AI-generated), via `parseSpaceIcon`. The one place that
 * union gets resolved, so every call site that used to do `<Icon name={space.icon} />` (SpacePage,
 * SpaceHeader, SpaceStrip, the command palette, ...) does `<SpaceIcon icon={space.icon} />` instead.
 *
 * `asset:` sanitization happens HERE, on every render — not once at generation/upload time — because
 * that is the actual XSS boundary: a stored SVG is untrusted on the way back out just as much as it
 * was on the way in (see `validateGeneratedSvg` on the server, which is a sanity filter, not this).
 */
export function SpaceIcon({ icon, size = 16, className }: { icon: string; size?: number; className?: string }) {
  const ref = parseSpaceIcon(icon);
  // Looked up by id across every profile's fetched library, not just the active space's profile —
  // callers here (sidebar rows, the command palette) render spaces from any profile, and asset ids
  // are ULIDs (globally unique), so there is no ambiguity in searching all of them. A profile whose
  // library was never fetched this session just degrades to the folder glyph below, the same as a
  // deleted asset — `refreshIconAssets` is what actually populates a profile's entry.
  const iconAssets = useApp((s) => s.iconAssets);
  const asset = ref.kind === "asset" ? Object.values(iconAssets).flat().find((a) => a.id === ref.id) : undefined;

  if (ref.kind === "hugeicon") return <Icon name={ref.name} size={size} className={className} />;
  if (ref.kind === "emoji") return <span className={className} style={{ fontSize: size, lineHeight: 1 }} role="img" aria-label="icon">{ref.char}</span>;

  // ref.kind === "asset": missing/deleted (or not yet loaded for this space's profile) degrades to
  // the folder glyph, the same graceful-fallback posture `Icon` already has for an unknown name.
  if (!asset) return <Icon name="folder" size={size} className={className} />;
  if (asset.mime === "image/svg+xml") return <SanitizedSvg svg={asset.dataText} size={size} className={className} />;
  // eslint-disable-next-line jsx-a11y/alt-text -- decorative glyph, same posture as Icon's own svgs
  return <img src={asset.dataText} width={size} height={size} className={className} />;
}

function SanitizedSvg({ svg, size, className }: { svg: string; size: number; className?: string }) {
  const clean = useMemo(() => DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }), [svg]);
  return <span className={className} style={{ display: "inline-flex", width: size, height: size }} dangerouslySetInnerHTML={{ __html: clean }} />;
}
