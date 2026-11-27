// The quick chat panel's material: macOS's own frosted vibrancy, cut to the panel's shapes.
//
// A window's material (Electron's `vibrancy`) is one rectangle behind the whole page, and the panel
// is a capsule, a pill and a card with clear desktop round them. So each shape gets its own
// NSVisualEffectView under the page, masked to its outline by a stretchable mask image, which is how
// AppKit rounds the material (setting a layer mask on the view breaks its blur). The page draws the
// ink and the rim over it; main says where the shapes are (main/panel-material.ts).
//
// Loaded into main as a Node-API module, so it runs on the main thread with the window.
//
//   setShapes(handle: Buffer, shapes: [{ x, bottom, width, height, radius, squircle, alpha }], material: string)
//
// `handle` is BrowserWindow.getNativeWindowHandle() (the window's content view). Shapes are in points
// from the view's left and BOTTOM edges, so a window that grows upward keeps them in place. An empty
// list takes the material away.

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>

static NSString *const kShapeId = @"realm.panel-material";

static NSBezierPath *Outline(NSRect rect, CGFloat r, BOOL squircle) {
  if (!squircle) return [NSBezierPath bezierPathWithRoundedRect:rect xRadius:r yRadius:r];
  // The painter's curve: each corner a quarter of |x|^4 + |y|^4 = 1 inside an r × r box.
  NSBezierPath *path = [NSBezierPath bezierPath];
  const int steps = 24;
  NSPoint centres[4] = {
    NSMakePoint(NSMaxX(rect) - r, NSMaxY(rect) - r), NSMakePoint(NSMinX(rect) + r, NSMaxY(rect) - r),
    NSMakePoint(NSMinX(rect) + r, NSMinY(rect) + r), NSMakePoint(NSMaxX(rect) - r, NSMinY(rect) + r),
  };
  for (int q = 0; q < 4; q++) {
    for (int i = 0; i <= steps; i++) {
      double t = (q + (double)i / steps) * M_PI_2;
      double c = cos(t), s = sin(t);
      NSPoint p = NSMakePoint(centres[q].x + r * copysign(sqrt(fabs(c)), c), centres[q].y + r * copysign(sqrt(fabs(s)), s));
      if (q == 0 && i == 0) [path moveToPoint:p]; else [path lineToPoint:p];
    }
  }
  [path closePath];
  return path;
}

// A corner drawn once and stretched along the shape's sides, so any size takes the same image.
static NSImage *MaskImage(CGFloat r, BOOL squircle) {
  CGFloat side = 2 * r + 1;
  NSImage *image = [NSImage imageWithSize:NSMakeSize(side, side) flipped:NO drawingHandler:^BOOL(NSRect rect) {
    [[NSColor blackColor] setFill];
    [Outline(rect, r, squircle) fill];
    return YES;
  }];
  image.capInsets = NSEdgeInsetsMake(r, r, r, r);
  image.resizingMode = NSImageResizingModeStretch;
  return image;
}

static NSVisualEffectMaterial MaterialNamed(NSString *name) {
  if ([name isEqualToString:@"hud"]) return NSVisualEffectMaterialHUDWindow;
  if ([name isEqualToString:@"menu"]) return NSVisualEffectMaterialMenu;
  if ([name isEqualToString:@"sidebar"]) return NSVisualEffectMaterialSidebar;
  return NSVisualEffectMaterialPopover;
}

static double NumberOf(napi_env env, napi_value object, const char *key, double fallback) {
  napi_value value;
  double out = fallback;
  if (napi_get_named_property(env, object, key, &value) == napi_ok) napi_get_value_double(env, value, &out);
  return out;
}

static bool BoolOf(napi_env env, napi_value object, const char *key) {
  napi_value value;
  bool out = false;
  if (napi_get_named_property(env, object, key, &value) == napi_ok) napi_get_value_bool(env, value, &out);
  return out;
}

static napi_value SetShapes(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  napi_value result;
  napi_get_boolean(env, false, &result);
  if (argc < 2) return result;

  void *data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length < sizeof(void *)) return result;
  NSView *content = (__bridge NSView *)(*(void **)data);
  if (![content isKindOfClass:[NSView class]]) return result;

  NSString *materialName = @"popover";
  if (argc > 2) {
    char buffer[32] = {0};
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, argv[2], buffer, sizeof buffer, &copied) == napi_ok) materialName = [NSString stringWithUTF8String:buffer];
  }

  uint32_t count = 0;
  napi_get_array_length(env, argv[1], &count);

  NSMutableArray<NSVisualEffectView *> *views = [NSMutableArray array];
  for (NSView *view in content.subviews) {
    if ([view.identifier isEqualToString:kShapeId]) [views addObject:(NSVisualEffectView *)view];
  }
  while (views.count > count) {
    [views.lastObject removeFromSuperview];
    [views removeLastObject];
  }

  CGFloat height = NSHeight(content.bounds);
  for (uint32_t i = 0; i < count; i++) {
    napi_value shape;
    napi_get_element(env, argv[1], i, &shape);
    CGFloat w = NumberOf(env, shape, "width", 0), h = NumberOf(env, shape, "height", 0);
    CGFloat x = NumberOf(env, shape, "x", 0), bottom = NumberOf(env, shape, "bottom", 0);
    CGFloat r = MIN(NumberOf(env, shape, "radius", 0), MIN(w, h) / 2);
    BOOL squircle = BoolOf(env, shape, "squircle");
    NSRect frame = NSMakeRect(x, content.isFlipped ? height - bottom - h : bottom, w, h);

    NSVisualEffectView *view = i < views.count ? views[i] : nil;
    if (!view) {
      view = [[NSVisualEffectView alloc] initWithFrame:frame];
      view.identifier = kShapeId;
      view.blendingMode = NSVisualEffectBlendingModeBehindWindow;
      // The panel never becomes the key window's owner app, and an inactive material goes grey.
      view.state = NSVisualEffectStateActive;
      // Held to the bottom edge, which is where main holds the window when it grows.
      view.autoresizingMask = content.isFlipped ? NSViewMinYMargin : NSViewMaxYMargin;
      [content addSubview:view positioned:NSWindowBelow relativeTo:nil];
      [views addObject:view];
    }
    view.material = MaterialNamed(materialName);
    view.frame = frame;
    NSNumber *key = @(r * (squircle ? -1 : 1));
    if (![objc_getAssociatedObject(view, (__bridge void *)kShapeId) isEqual:key]) {
      view.maskImage = MaskImage(r, squircle);
      objc_setAssociatedObject(view, (__bridge void *)kShapeId, key, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    view.alphaValue = MAX(0, MIN(1, NumberOf(env, shape, "alpha", 1)));
  }
  napi_get_boolean(env, true, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "setShapes", NAPI_AUTO_LENGTH, SetShapes, NULL, &fn);
  napi_set_named_property(env, exports, "setShapes", fn);
  return exports;
}
