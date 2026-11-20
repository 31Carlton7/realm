// sck: what each capture path returns for two windows, a control and a protected one, for the
// quick chat panel's live check (../quick-chat-panel-live.mjs). Prints one JSON object. No AppKit: this must stay a plain tool, so macOS holds the
// app that launched it responsible for the capture.
//
//   sck all <controlWindowId> <protectedWindowId>
//       For both windows: is it in SCShareableContent, what the window server says its sharing state
//       is, and its mean colour through
//         shotDisplay    SCScreenshotManager, whole display, nothing excluded
//         shotWindow     SCScreenshotManager, that window alone (desktopIndependentWindow)
//         streamDisplay  one SCStream frame of the whole display (how Chromium captures a screen)
//         streamWindow   one SCStream frame of that window (how Chromium captures a window)
//         legacyDisplay  CGWindowListCreateImage over the window's rectangle, everything on screen
//         legacyWindow   CGWindowListCreateImage of that window alone
//   sck png <file> [x y w h]   mean colour of a PNG, or of a rectangle of it given in 0–1 fractions
//
// Build: swiftc -O -o bin/sck src/sck.swift

import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit

func emit(_ o: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), encoding: .utf8)!) }

/// Mean R, G, B, A (0–255) of an image, or of `rect` given in pixels.
func mean(_ image: CGImage, _ rect: CGRect? = nil) -> [Int] {
  let w = image.width, h = image.height
  var data = [UInt8](repeating: 0, count: w * h * 4)
  let ctx = CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  let r = (rect ?? CGRect(x: 0, y: 0, width: w, height: h)).integral.intersection(CGRect(x: 0, y: 0, width: w, height: h))
  guard r.width >= 1, r.height >= 1 else { return [] }
  var sum = [0, 0, 0, 0]
  for y in Int(r.minY)..<Int(r.maxY) { for x in Int(r.minX)..<Int(r.maxX) { for c in 0..<4 { sum[c] += Int(data[(y * w + x) * 4 + c]) } } }
  let n = Int(r.width) * Int(r.height)
  return sum.map { $0 / n }
}

/// The middle half of a window's rectangle, in the pixels of an image that covers `display`.
func inner(_ frame: CGRect, display: CGRect, image: CGImage) -> CGRect {
  let s = CGFloat(image.width) / display.width
  return CGRect(x: (frame.minX - display.minX + frame.width / 4) * s, y: (frame.minY - display.minY + frame.height / 4) * s,
                width: frame.width / 2 * s, height: frame.height / 2 * s)
}

final class OneFrame: NSObject, SCStreamOutput, SCStreamDelegate {
  var image: CGImage?
  let done = DispatchSemaphore(value: 0)
  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard image == nil, type == .screen, let buffer = sampleBuffer.imageBuffer else { return }
    // Only a frame that carries a picture: idle and blank frames have no usable pixels.
    if let info = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
       let raw = info[.status] as? Int, raw != SCFrameStatus.complete.rawValue { return }
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer),
                        bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    image = ctx?.makeImage()
    done.signal()
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) { done.signal() }
}

func streamFrame(_ filter: SCContentFilter, width: Int, height: Int) async -> Result<CGImage, Error> {
  let config = SCStreamConfiguration()
  config.width = width; config.height = height
  config.pixelFormat = kCVPixelFormatType_32BGRA
  config.showsCursor = false
  let out = OneFrame()
  let stream = SCStream(filter: filter, configuration: config, delegate: out)
  do {
    try stream.addStreamOutput(out, type: .screen, sampleHandlerQueue: DispatchQueue(label: "sck.frame"))
    try await stream.startCapture()
    _ = await withCheckedContinuation { (c: CheckedContinuation<DispatchTimeoutResult, Never>) in
      DispatchQueue.global().async { c.resume(returning: out.done.wait(timeout: .now() + 3)) }
    }
    try? await stream.stopCapture()
    guard let image = out.image else { return .failure(NSError(domain: "sck", code: 1, userInfo: [NSLocalizedDescriptionKey: "no complete frame in 3 s"])) }
    return .success(image)
  } catch { return .failure(error) }
}

func shot(_ filter: SCContentFilter, width: Int, height: Int) async -> Result<CGImage, Error> {
  let config = SCStreamConfiguration()
  config.width = width; config.height = height
  config.showsCursor = false
  do { return .success(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)) } catch { return .failure(error) }
}

typealias LegacyCapture = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
let legacy = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage").map { unsafeBitCast($0, to: LegacyCapture.self) }

func describe(_ r: Result<CGImage, Error>, _ rect: (CGImage) -> CGRect?) -> Any {
  switch r {
  case .success(let image): return ["rgba": mean(image, rect(image)), "size": [image.width, image.height]]
  case .failure(let e): return ["error": "\((e as NSError).domain) \((e as NSError).code): \(e.localizedDescription)"]
  }
}

let args = Array(CommandLine.arguments.dropFirst())

if args.first == "png", args.count >= 2 {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    emit(["error": "unreadable"]); exit(1)
  }
  var rect: CGRect?
  if args.count == 6, let x = Double(args[2]), let y = Double(args[3]), let w = Double(args[4]), let h = Double(args[5]) {
    rect = CGRect(x: x * Double(image.width), y: y * Double(image.height), width: w * Double(image.width), height: h * Double(image.height))
  }
  emit(["rgba": mean(image, rect), "size": [image.width, image.height]])
  exit(0)
}

guard args.first == "all", args.count == 3, let controlId = UInt32(args[1]), let protectedId = UInt32(args[2]) else {
  print("usage: sck all <controlWindowId> <protectedWindowId> | sck png <file> [x y w h]"); exit(1)
}
guard CGPreflightScreenCaptureAccess() else { emit(["error": "screen capture is not granted: nothing captured"]); exit(3) }

let server = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
func serverInfo(_ id: UInt32) -> [String: Any]? { server.first { ($0[kCGWindowNumber as String] as? UInt32) == id } }
func frame(_ id: UInt32) -> CGRect? {
  guard let b = serverInfo(id)?[kCGWindowBounds as String] as? NSDictionary else { return nil }
  return CGRect(dictionaryRepresentation: b)
}

var result: [String: Any] = [:]
let content: SCShareableContent
do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) } catch {
  emit(["error": "SCShareableContent: \(error.localizedDescription)"]); exit(2)
}
guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { emit(["error": "no display"]); exit(2) }
let scale = Int((CGDisplayCopyDisplayMode(display.displayID)?.pixelWidth ?? display.width) / max(display.width, 1))
let px = (w: display.width * max(scale, 1), h: display.height * max(scale, 1))
result["display"] = ["points": [display.width, display.height], "pixels": [px.w, px.h]]

let displayFilter = SCContentFilter(display: display, excludingWindows: [])
let shotDisplay = await shot(displayFilter, width: px.w, height: px.h)
let streamDisplay = await streamFrame(displayFilter, width: px.w, height: px.h)

for (name, id) in [("control", controlId), ("protected", protectedId)] {
  var row: [String: Any] = [:]
  guard let f = frame(id) else { result[name] = ["error": "the window server does not list window \(id)"]; continue }
  row["serverSharingState"] = serverInfo(id)?[kCGWindowSharingState as String] ?? -1
  row["serverAlpha"] = serverInfo(id)?[kCGWindowAlpha as String] ?? -1
  let scWindow = content.windows.first { $0.windowID == id }
  row["inShareableContent"] = scWindow != nil
  row["shotDisplay"] = describe(shotDisplay) { inner(f, display: display.frame, image: $0) }
  row["streamDisplay"] = describe(streamDisplay) { inner(f, display: display.frame, image: $0) }
  if let w = scWindow {
    let filter = SCContentFilter(desktopIndependentWindow: w)
    let size = (w: Int(f.width) * max(scale, 1), h: Int(f.height) * max(scale, 1))
    row["shotWindow"] = describe(await shot(filter, width: size.w, height: size.h)) { _ in nil }
    row["streamWindow"] = describe(await streamFrame(filter, width: size.w, height: size.h)) { _ in nil }
  } else {
    row["shotWindow"] = ["error": "not in SCShareableContent, so there is no SCWindow to capture"]
    row["streamWindow"] = ["error": "not in SCShareableContent, so there is no SCWindow to capture"]
  }
  if let legacy {
    // kCGWindowListOptionOnScreenOnly = 1, kCGWindowListOptionIncludingWindow = 8, kCGWindowImageBoundsIgnoreFraming = 1
    if let image = legacy(f, 1, 0, 0)?.takeRetainedValue() {
      row["legacyDisplay"] = ["rgba": mean(image, CGRect(x: image.width / 4, y: image.height / 4, width: image.width / 2, height: image.height / 2)), "size": [image.width, image.height]]
    } else { row["legacyDisplay"] = ["error": "returned no image"] }
    if let image = legacy(.null, 8, id, 1)?.takeRetainedValue() {
      row["legacyWindow"] = ["rgba": mean(image), "size": [image.width, image.height]]
    } else { row["legacyWindow"] = ["error": "returned no image"] }
  } else {
    row["legacyDisplay"] = ["error": "CGWindowListCreateImage is not exported on this macOS"]
    row["legacyWindow"] = ["error": "CGWindowListCreateImage is not exported on this macOS"]
  }
  result[name] = row
}
emit(result)
