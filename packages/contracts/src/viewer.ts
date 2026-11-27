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

const MouseButton = z.enum(["left", "middle", "right", "none"]);
const pointer = {
  type: z.literal("pointer"),
  x: z.number(), y: z.number(),
  width: z.number().positive(), height: z.number().positive(),
  clickCount: z.number().int().min(0).default(1),
  deltaX: z.number().default(0), deltaY: z.number().default(0),
  modifiers: Modifiers,
};

/**
 * What the input socket takes. Pointer positions are in VIEWER coordinates: CSS pixels inside a box
 * of `width` x `height` in which the picture is letterboxed (object-fit: contain). The relay maps
 * them to the page.
 *
 * A press or release is the left button unless it says otherwise; a move or a wheel is no button,
 * so a hover is not read as a drag. A drag sends its moves with the button held.
 */
export const ViewerInputSchema = z.union([
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
