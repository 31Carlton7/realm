import { z } from "zod";
import { IdSchema } from "./ids";

/**
 * A hidden app shown as a picture: a quiet Electron app (or later a native app or a dev page) that
 * never puts a window in front of anyone, streamed to one loopback MJPEG URL with one input socket
 * beside it. The simulator pane's shape, for things that are not phones.
 */
export const ViewerKindSchema = z.enum(["electron", "native", "web"]);
export type ViewerKind = z.infer<typeof ViewerKindSchema>;

export const ViewerStatusSchema = z.enum(["connecting", "live", "exited"]);
export type ViewerStatus = z.infer<typeof ViewerStatusSchema>;

export const ViewerSchema = z.object({
  id: IdSchema,
  kind: ViewerKindSchema,
  title: z.string(),
  /** `multipart/x-mixed-replace` JPEG frames. Loopback, with this viewer's own secret in the path. */
  streamUrl: z.string(),
  /** A WebSocket taking `ViewerInput` messages as JSON text. */
  inputUrl: z.string(),
  /** A WebSocket sending the picture as layers, for a viewer that draws the app's child views itself:
   *  a `ViewerLayout` as JSON text when it connects and whenever the layers change, and each layer's
   *  frames as binary messages (`encodeViewerFrame`). `streamUrl` carries the window layer alone. */
  layersUrl: z.string(),
  status: ViewerStatusSchema,
  pid: z.number().int().nullable(),
});
export type Viewer = z.infer<typeof ViewerSchema>;

export const ViewerOpenSchema = z.object({
  kind: z.literal("electron"),
  /** A quiet app Realm launched itself, as its launcher recorded it. The DevTools port comes from that
   *  record and never from the caller: CDP input skips every guard the app's own UI has, so a port
   *  named by a caller could drive anything on this Mac with a debug port open. */
  appId: IdSchema,
  /** Which page to show when the app has several: the DevTools target id (`/json/list`'s `id`)… */
  targetId: z.string().max(128).optional(),
  /** …or else the first page target whose URL starts with this. Two windows of one app often share a
   *  URL (Realm's main window and its quick chat panel do), so an id is the reliable choice. */
  targetUrl: z.string().optional(),
  title: z.string().max(200).optional(),
  /** The pane's size in device pixels. The screencast is scaled down to fit it; absent, frames come
   *  at the page's own size. */
  maxWidth: z.number().int().positive().optional(),
  maxHeight: z.number().int().positive().optional(),
  /** Keep one painted frame in this many. Moving content at 1 streams every frame Chromium paints. */
  everyNthFrame: z.number().int().positive().default(1),
});
export type ViewerOpen = z.input<typeof ViewerOpenSchema>;

/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const Modifiers = z.number().int().min(0).max(15).default(0);

/** A layer of the picture: `VIEWER_WINDOW_LAYER` for the window's own page, or else a child view's
 *  DevTools target id. */
export const VIEWER_WINDOW_LAYER = "window";
const LayerId = z.string().regex(/^[\w-]{1,128}$/);

const MouseButton = z.enum(["left", "middle", "right", "none"]);
const pointing = {
  type: z.literal("pointer"),
  x: z.number(), y: z.number(),
  clickCount: z.number().int().min(0).default(1),
  deltaX: z.number().default(0), deltaY: z.number().default(0),
  modifiers: Modifiers,
};
const pointer = { ...pointing, width: z.number().positive(), height: z.number().positive(), layer: z.never().optional() };
const onLayer = { ...pointing, layer: LayerId };

/**
 * What the input socket takes. A pointer event naming a `layer` is in that layer's own CSS pixels,
 * from its rect's top left (`ViewerLayer`), and goes to that layer's page. One with no layer is in
 * VIEWER coordinates: CSS pixels inside a box of `width` x `height` in which the window's picture is
 * letterboxed (object-fit: contain), and goes to the topmost layer under the point.
 *
 * Keys and text go to the page that took the last press.
 *
 * A press or release is the left button unless it says otherwise; a move or a wheel is no button,
 * so a hover is not read as a drag. A drag sends its moves with the button held.
 */
export const ViewerInputSchema = z.union([
  z.object({ ...onLayer, action: z.enum(["down", "up"]), button: MouseButton.default("left") }),
  z.object({ ...onLayer, action: z.enum(["move", "wheel"]), button: MouseButton.default("none") }),
  z.object({ ...pointer, action: z.enum(["down", "up"]), button: MouseButton.default("left") }),
  z.object({ ...pointer, action: z.enum(["move", "wheel"]), button: MouseButton.default("none") }),
  z.object({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string(),
    code: z.string().default(""),
    /** DOM `keyCode`. Chromium needs it for Enter, Backspace, arrows and shortcuts to do anything. */
    keyCode: z.number().int().default(0),
    /** The character a down press types, if any. */
    text: z.string().optional(),
    modifiers: Modifiers,
  }),
  z.object({ type: z.literal("text"), text: z.string() }),
]);
export type ViewerInput = z.input<typeof ViewerInputSchema>;

/**
 * A child view drawn over a window's own page, such as a browser pane, which the window's screencast
 * cannot see. A quiet Realm's main keeps the list for each window in that window's page,
 * in `CHILD_VIEWS_GLOBAL`, and calls `CHILD_VIEWS_BINDING` with it whenever it changes, so a relay on
 * the window's DevTools socket can stream each one as a layer of its own. The rect is in the window
 * page's CSS pixels; `targetId` is the child's own DevTools target.
 */
export const ViewerChildViewSchema = z.object({
  targetId: z.string(),
  x: z.number(), y: z.number(),
  width: z.number().nonnegative(), height: z.number().nonnegative(),
});
export type ViewerChildView = z.infer<typeof ViewerChildViewSchema>;
export const CHILD_VIEWS_GLOBAL = "__realmChildViews";
export const CHILD_VIEWS_BINDING = "__realmChildViewsChanged";

/** One layer's place: a rect in the window page's CSS pixels, and its stacking order. The window is
 *  z 0 at 0,0 and its page's size (0 x 0 until its first frame); its child views follow, bottom first. */
export const ViewerLayerSchema = z.object({
  id: LayerId,
  x: z.number(), y: z.number(),
  width: z.number().nonnegative(), height: z.number().nonnegative(),
  z: z.number().int().nonnegative(),
});
export type ViewerLayer = z.infer<typeof ViewerLayerSchema>;

/** The layers socket's text message: every layer, bottom first. */
export const ViewerLayoutSchema = z.object({
  type: z.literal("layout"),
  layers: z.array(ViewerLayerSchema),
});
export type ViewerLayout = z.infer<typeof ViewerLayoutSchema>;

/** What heads each binary message on the layers socket: whose frame the JPEG after it is. */
export const ViewerFrameHeaderSchema = z.object({
  type: z.literal("frame"),
  layer: LayerId,
});
export type ViewerFrameHeader = z.infer<typeof ViewerFrameHeaderSchema>;

/** A layer's frame as one binary message: the header's length as a big-endian uint16, the header
 *  as JSON, then the JPEG exactly as the app's screencast sent it. */
export function encodeViewerFrame(layer: string, jpeg: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(ViewerFrameHeaderSchema.parse({ type: "frame", layer })));
  const out = new Uint8Array(2 + header.length + jpeg.length);
  new DataView(out.buffer).setUint16(0, header.length);
  out.set(header, 2);
  out.set(jpeg, 2 + header.length);
  return out;
}

/** The other side of `encodeViewerFrame`; null for anything that is not one. */
export function decodeViewerFrame(bytes: Uint8Array): { layer: string; jpeg: Uint8Array } | null {
  if (bytes.length < 2) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0);
  if (bytes.length < 2 + length) return null;
  let header: unknown;
  try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(2, 2 + length))); } catch { return null; }
  const parsed = ViewerFrameHeaderSchema.safeParse(header);
  return parsed.success ? { layer: parsed.data.layer, jpeg: bytes.subarray(2 + length) } : null;
}
