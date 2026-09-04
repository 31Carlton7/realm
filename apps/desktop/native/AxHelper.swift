// AxHelper — macOS Accessibility helper. Speaks newline-delimited JSON on stdin/stdout: one request
// object per line in, one response object per line out, ids echoed back.
//
// Why a LONG-LIVED process rather than a CLI invoked once per operation: an `AXUIElement` is a live,
// process-local handle, not a serialisable address. Nothing about it survives a process boundary —
// there is no path, no id, no stable coordinate. So the only way `click(index: 12)` can mean the same
// element that `snapshot` enumerated is for the process that walked the tree to still be holding that
// handle. A one-shot CLI would have to re-walk and re-index on every call, and any change to the app
// between the two walks (a menu opening, a row loading, a spinner disappearing) would silently
// renumber everything under the agent's feet. A tree walk is also the expensive part — hundreds of
// synchronous mach round-trips into the target app — and paying it per click would make a ten-step
// task take minutes.
//
// The snapshot table is therefore this process's whole reason to exist, and it is deliberately
// SHALLOW: only the newest snapshot per app is retained (see `Snapshots`). Indices are re-resolved
// against the live element at act time and a destroyed element refuses rather than acting on
// whatever inherited its position.
//
// Design of the tool surface (snapshot → index → act, one screenshot alongside the tree) follows
// open-codex-computer-use (MIT, iFurySt); the code and the safety model here are Realm's own.
//
// Build: swiftc -O -o bin/axhelper AxHelper.swift   (see scripts/build-native.mjs)
// Exits when stdin closes (parent gone).

import AppKit
import ApplicationServices
// Carbon, for `UCKeyTranslate` and the Text Input Services layout query. There is no modern
// replacement: mapping a character back to a virtual keycode is only expressible through the
// 'uchr' layout resource, which lives here.
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ScreenCaptureKit

// ── Limits ──────────────────────────────────────────────────────────────────────────────────────

/// Per-message timeout for AX calls into a target app. macOS's default is 6 seconds PER ATTRIBUTE
/// READ, and a tree walk makes thousands: one beachballed app would otherwise wedge this process for
/// hours. 1.5s is far above a healthy app's response (microseconds) and low enough that a hung app
/// costs one attribute, not the snapshot.
private let AX_TIMEOUT_SECONDS: Float = 1.5

/// Walk bounds. Real apps are much bigger than they look: a Safari window with a busy page, or any
/// Electron app, exposes tens of thousands of AX nodes, nearly all of them unaddressable leaf text.
/// These caps are what keep a snapshot a page of text instead of a megabyte, and they are reported
/// (`truncated`) rather than applied silently.
private let MAX_ELEMENTS = 500
private let MAX_DEPTH = 32
private let MAX_CHILDREN_PER_NODE = 256
/// Total nodes VISITED, including the ones filtered out. Bounds the walk itself, not its output —
/// a tree can contain 40k invisible nodes and yield 12 interesting ones.
private let MAX_VISITS = 20_000
/// An `AXValue` can be a whole document. Clipped here rather than in the parent: the point is to not
/// carry it across the pipe at all.
private let MAX_VALUE_CHARS = 256

/// How long to wait for a target app to actually come forward after being asked. Activation is
/// asynchronous and cooperative — the app has to finish becoming key — and clicking before it lands
/// sends the click to whatever is still on top.
private let ACTIVATE_TIMEOUT_MS = 1200

/// Gap between a synthetic mouse-down and its mouse-up. Zero-duration clicks are dropped or
/// misread as drags by AppKit's own click tracking; ~24ms reads as a deliberate human click
/// everywhere it was tried.
private let CLICK_HOLD_US: UInt32 = 24_000

/// Screenshot capture is a hard wait on another subsystem; if ScreenCaptureKit never calls back
/// (no grant, a display in a strange state) the snapshot must still return its tree.
private let CAPTURE_TIMEOUT_S = 4.0

// ── Bundles this helper will never touch ────────────────────────────────────────────────────────

/// Apps no agent may drive, refused at the lowest level so that no caller — however it was
/// configured — can reach them.
///
/// System Settings is the load-bearing entry: it is where every TCC grant lives, so an agent able to
/// click inside it could grant itself Full Disk Access, Screen Recording, or Accessibility for
/// anything, and the OS-level permission model this helper sits behind would stop meaning anything.
/// The security agent is the modal that asks for the user's password and Touch ID; Keychain Access
/// hands out secrets in plain text. None of these are things a permission prompt could sensibly
/// describe, so they are not prompts — they are refusals.
private let FORBIDDEN_BUNDLE_IDS: Set<String> = [
  // Realm itself, named statically as well as derived from the process ancestry.
  //
  // The ancestry check answers "which app is hosting me", and under `pnpm dev` or a live-check script
  // that is Electron rather than Realm — so a SEPARATE Realm.app running alongside would not match it
  // and was, before this line, listed as driveable. Any Realm window is a window permission cards
  // appear in, whichever process drew it, so the identity that matters is the product's and not this
  // process tree's. Caught by scripts/computer-use-live.cjs, which asserts the exclusion rather than
  // assuming it.
  "co.charmtechnologies.realm",
  "com.apple.systempreferences",       // System Settings (and its System Preferences ancestor)
  "com.apple.SecurityAgent",           // the password / Touch ID modal
  "com.apple.security.pboxd",          // Powerbox — the file-grant dialog TCC drives
  "com.apple.keychainaccess",
  "com.apple.Terminal",
  "com.googlecode.iterm2",
]

// ── JSON plumbing ───────────────────────────────────────────────────────────────────────────────

private func writeLine(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

private struct HelperError: Error {
  let message: String
  /// A machine-readable tag the parent branches on, for the few failures that mean something
  /// specific to the agent — chiefly "your indices are stale, take a new snapshot".
  let code: String
  init(_ message: String, code: String = "failed") {
    self.message = message
    self.code = code
  }
}

// ── Accessibility reads ─────────────────────────────────────────────────────────────────────────

private func axCopy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
  guard let raw = axCopy(element, attribute) else { return nil }
  if let s = raw as? String { return s }
  // AXValue for a text field can arrive as an AXTextMarker or a number (steppers, sliders). Numbers
  // are worth showing; opaque marker types are not, and `String(describing:)` on one produces noise.
  if let n = raw as? NSNumber { return n.stringValue }
  return nil
}

private func axBool(_ element: AXUIElement, _ attribute: String) -> Bool? {
  (axCopy(element, attribute) as? NSNumber)?.boolValue
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  guard let raw = axCopy(element, kAXChildrenAttribute as String) else { return [] }
  guard let array = raw as? [AXUIElement] else { return [] }
  return array.count > MAX_CHILDREN_PER_NODE ? Array(array.prefix(MAX_CHILDREN_PER_NODE)) : array
}

private func axActions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return (names as? [String]) ?? []
}

/// An element's frame in GLOBAL SCREEN COORDINATES — origin at the top-left of the primary display,
/// y growing downward.
///
/// This is the same space `CGEvent` mouse positions use, which is why nothing in this file flips a
/// coordinate. It is NOT the space `NSScreen`/`NSWindow` use (bottom-left origin), so an AX frame
/// must never be mixed with an AppKit frame without converting — the bug that produces is a click
/// mirrored about the middle of the screen, which lands on something real and looks like a
/// mis-identified element rather than a coordinate bug.
private func axFrame(_ element: AXUIElement) -> CGRect? {
  guard let posValue = axCopy(element, kAXPositionAttribute as String),
        let sizeValue = axCopy(element, kAXSizeAttribute as String) else { return nil }
  var origin = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(posValue as! AXValue, .cgPoint, &origin),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
  return CGRect(origin: origin, size: size)
}

private func clip(_ s: String, _ n: Int) -> String {
  let flat = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
  return flat.count > n ? String(flat.prefix(n - 1)) + "…" : flat
}

// ── The element table ───────────────────────────────────────────────────────────────────────────

private struct Element {
  let index: Int
  let handle: AXUIElement
  let role: String
  let subrole: String
  let name: String
  let value: String
  let frame: CGRect
  let actions: [String]
  let enabled: Bool
  let focused: Bool
  let depth: Int

  var wire: [String: Any] {
    [
      "index": index, "role": role, "subrole": subrole, "name": name, "value": value,
      "x": Int(frame.origin.x.rounded()), "y": Int(frame.origin.y.rounded()),
      "w": Int(frame.size.width.rounded()), "h": Int(frame.size.height.rounded()),
      "actions": actions, "enabled": enabled, "focused": focused, "depth": depth,
    ]
  }
}

private struct Snapshot {
  let id: String
  let pid: pid_t
  let bundleId: String
  let appName: String
  let elements: [Element]
}

/// Exactly one snapshot per app, replaced on each new walk.
///
/// Keeping a history would let an agent act on indices from two snapshots ago — which is precisely
/// the failure this whole indexing scheme exists to prevent, since the elements are still alive and
/// would happily be clicked. "Your snapshot is stale, take another" is a recoverable error; clicking
/// the button that used to be at index 12 is not.
private final class Snapshots {
  private var byPid: [pid_t: Snapshot] = [:]

  static func staleError(_ snapshotId: String) -> HelperError {
    HelperError("snapshot \(snapshotId) is no longer current — take a fresh snapshot before acting", code: "stale_snapshot")
  }

  func store(_ snapshot: Snapshot) {
    byPid[snapshot.pid] = snapshot
  }

  func resolve(snapshotId: String, index: Int) throws -> Element {
    guard let snapshot = app(snapshotId: snapshotId) else { throw Snapshots.staleError(snapshotId) }
    guard let element = snapshot.elements.first(where: { $0.index == index }) else {
      throw HelperError("no element \(index) in snapshot \(snapshotId)", code: "no_element")
    }
    return element
  }

  func app(snapshotId: String) -> Snapshot? {
    byPid.values.first { $0.id == snapshotId }
  }

  func forget(pid: pid_t) {
    byPid.removeValue(forKey: pid)
  }
}

// ── Tree walk ───────────────────────────────────────────────────────────────────────────────────

/// Roles kept even when they carry no name and no actions, because their presence is the
/// information: a text field the user has not typed in yet is nameless and actionless, and is
/// exactly what an agent is looking for.
private let ALWAYS_KEEP_ROLES: Set<String> = [
  "AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXSearchField",
  "AXCheckBox", "AXRadioButton", "AXSlider", "AXIncrementor", "AXStepper",
  "AXPopUpButton", "AXMenuButton", "AXWindow", "AXSheet", "AXDrawer",
]

/// Roles whose subtree is never worth walking. `AXMenuBar` is the big one: every app's menu bar is
/// hundreds of items deep, it is the same on every snapshot, and an agent that wants a menu command
/// should press its key equivalent rather than click three levels of menu. An OPEN menu
/// (`AXMenu` presented as a window) is still reachable — this only skips the resting menu bar.
private let SKIP_SUBTREE_ROLES: Set<String> = ["AXMenuBar"]

private func walk(app: AXUIElement) -> (elements: [Element], truncated: Bool) {
  var elements: [Element] = []
  var visits = 0
  var truncated = false

  // Windows rather than the application element's children: an application's direct children also
  // include the menu bar and every floating panel the app has ever made, in no useful order.
  // `kAXWindowsAttribute` is the ordered, front-to-back list of what is actually on screen.
  var roots = (axCopy(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
  if roots.isEmpty, let focused = axCopy(app, kAXFocusedWindowAttribute as String) {
    roots = [focused as! AXUIElement]
  }

  func visit(_ element: AXUIElement, depth: Int) {
    if visits >= MAX_VISITS || elements.count >= MAX_ELEMENTS {
      truncated = true
      return
    }
    visits += 1

    let role = axString(element, kAXRoleAttribute as String) ?? ""
    if SKIP_SUBTREE_ROLES.contains(role) { return }

    let actions = axActions(element)
    // Title first, then the label variants apps actually populate. `AXDescription` is what carries
    // the name of an icon-only toolbar button — the single most common thing an agent needs to click
    // and the one place a title is always empty.
    let name = clip(
      axString(element, kAXTitleAttribute as String).flatMap { $0.isEmpty ? nil : $0 }
        ?? axString(element, kAXDescriptionAttribute as String).flatMap { $0.isEmpty ? nil : $0 }
        ?? axString(element, kAXPlaceholderValueAttribute as String).flatMap { $0.isEmpty ? nil : $0 }
        ?? axString(element, kAXHelpAttribute as String)
        ?? "",
      MAX_VALUE_CHARS)

    // A secure text field's value is the password. It is never read, at any length: even the LENGTH
    // of a password is information Realm has no business carrying into a model's context.
    let isSecure = role == "AXSecureTextField"
    let value = isSecure ? "" : clip(axString(element, kAXValueAttribute as String) ?? "", MAX_VALUE_CHARS)

    let frame = axFrame(element)
    // Zero-area elements cannot be clicked and are the bulk of a real tree (layout groups, collapsed
    // rows, offscreen list items an app keeps realised). Dropping them here is what makes the
    // element cap sufficient.
    let visible = frame.map { $0.width >= 1 && $0.height >= 1 } ?? false
    let interesting = !actions.isEmpty || !name.isEmpty || !value.isEmpty || ALWAYS_KEEP_ROLES.contains(role)

    if visible, interesting, let frame {
      elements.append(Element(
        index: elements.count, handle: element, role: role,
        subrole: axString(element, kAXSubroleAttribute as String) ?? "",
        name: name, value: value, frame: frame, actions: actions,
        enabled: axBool(element, kAXEnabledAttribute as String) ?? true,
        focused: axBool(element, kAXFocusedAttribute as String) ?? false,
        depth: depth))
    }

    if depth >= MAX_DEPTH {
      truncated = true
      return
    }
    for child in axChildren(element) { visit(child, depth: depth + 1) }
  }

  for root in roots { visit(root, depth: 0) }
  return (elements, truncated)
}

// ── Screen capture ──────────────────────────────────────────────────────────────────────────────

/// Capture the target app's on-screen windows as one JPEG, or nil.
///
/// Nil is an ordinary outcome, not an error: Screen Recording is a separate TCC grant from
/// Accessibility, and the AX tree — which is what acting actually depends on — is useful without it.
/// The parent says so rather than failing the snapshot.
///
/// ScreenCaptureKit rather than `CGWindowListCreateImage`: the latter is deprecated and, since
/// macOS 15, returns a black or desktop-only image when Screen Recording is not granted instead of
/// failing — a silent wrong answer, which is worse than none.
private func captureApp(pid: pid_t) -> String? {
  let contentSemaphore = DispatchSemaphore(value: 0)
  var content: SCShareableContent?
  SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { fetched, _ in
    content = fetched
    contentSemaphore.signal()
  }
  guard contentSemaphore.wait(timeout: .now() + CAPTURE_TIMEOUT_S) == .success,
        let content,
        let display = content.displays.first else { return nil }

  let windows = content.windows.filter { $0.owningApplication?.processID == pid }
  guard !windows.isEmpty else { return nil }

  let filter = SCContentFilter(display: display, including: windows)
  let config = SCStreamConfiguration()
  // The filter's own bounds, so the image is the app's windows rather than a mostly-empty desktop.
  // `contentRect` is in points; scaling to 1x keeps a Retina capture from being four times the
  // bytes for detail no model reads.
  config.width = Int(filter.contentRect.width)
  config.height = Int(filter.contentRect.height)
  config.captureResolution = .nominal
  config.showsCursor = false

  let shotSemaphore = DispatchSemaphore(value: 0)
  var image: CGImage?
  SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { captured, _ in
    image = captured
    shotSemaphore.signal()
  }
  guard shotSemaphore.wait(timeout: .now() + CAPTURE_TIMEOUT_S) == .success, let image else { return nil }

  let bitmap = NSBitmapImageRep(cgImage: image)
  guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else { return nil }
  return jpeg.base64EncodedString()
}

// ── Synthetic input ─────────────────────────────────────────────────────────────────────────────

/// Maps a printable character to a virtual keycode using the CURRENT keyboard layout.
///
/// Built by translating every keycode with no modifiers and inverting the result, rather than by
/// hardcoding the ANSI US table: on a Dvorak or AZERTY layout the hardcoded table types a different
/// letter than the one asked for, and `cmd+c` — the shortcut most worth getting right — would fire
/// whatever sits where C is on a US board.
private func buildKeycodeMap() -> [Character: CGKeyCode] {
  guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let layoutPointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return [:] }
  let layoutData = Unmanaged<CFData>.fromOpaque(layoutPointer).takeUnretainedValue() as Data

  var map: [Character: CGKeyCode] = [:]
  layoutData.withUnsafeBytes { raw in
    guard let layout = raw.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return }
    for code in CGKeyCode(0)...CGKeyCode(127) {
      var deadKeyState: UInt32 = 0
      var length = 0
      var chars = [UniChar](repeating: 0, count: 4)
      let status = UCKeyTranslate(
        layout, code, UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
        OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeyState, chars.count, &length, &chars)
      guard status == noErr, length == 1 else { continue }
      let character = Character(UnicodeScalar(chars[0]) ?? " ")
      // First keycode wins: the number row should map before the numeric keypad, which produces the
      // same characters and is not what "press 5" means.
      if map[character] == nil, !character.isWhitespace { map[character] = code }
    }
  }
  return map
}

/// Keys with no printable character, by the names the tool surface accepts.
private let NAMED_KEYCODES: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
  "escape": 53, "esc": 53, "forwarddelete": 117,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
  "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

private let MODIFIER_FLAGS: [String: CGEventFlags] = [
  "command": .maskCommand, "control": .maskControl, "option": .maskAlternate,
  "shift": .maskShift, "function": .maskSecondaryFn,
]

private final class Input {
  /// One event source for the whole process. A fresh `CGEventSource` per event resets the source's
  /// own modifier and click state, which is what makes double-clicks register as two singles.
  private let source = CGEventSource(stateID: .hidSystemState)
  private lazy var keycodes: [Character: CGKeyCode] = buildKeycodeMap()

  func flags(for modifiers: [String]) -> CGEventFlags {
    modifiers.reduce(into: CGEventFlags()) { acc, name in
      if let flag = MODIFIER_FLAGS[name.lowercased()] { acc.insert(flag) }
    }
  }

  func keycode(for key: String) throws -> CGKeyCode {
    if let named = NAMED_KEYCODES[key.lowercased()] { return named }
    if key.count == 1, let code = keycodes[Character(key.lowercased())] { return code }
    throw HelperError("no key named \"\(key)\" on this keyboard layout")
  }

  /// Move the pointer, then press and release.
  ///
  /// The move is not cosmetic. Apps track hover through mouse-moved events, and a button that has
  /// never seen the pointer arrive frequently ignores a down/up pair at its coordinates — AppKit
  /// tracking areas, and every web view, behave this way. The move also leaves the cursor where the
  /// user can see what was clicked.
  func click(at point: CGPoint, button: CGMouseButton, clickCount: Int, modifiers: CGEventFlags) {
    let (down, up): (CGEventType, CGEventType) = switch button {
    case .right: (.rightMouseDown, .rightMouseUp)
    case .center: (.otherMouseDown, .otherMouseUp)
    default: (.leftMouseDown, .leftMouseUp)
    }
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left), modifiers)
    for n in 1...max(1, clickCount) {
      // `mouseEventClickState` is what distinguishes a double-click from two clicks; without it a
      // pair of down/up events one millisecond apart is still two separate single clicks to AppKit.
      let downEvent = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: point, mouseButton: button)
      downEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      post(downEvent, modifiers)
      usleep(CLICK_HOLD_US)
      let upEvent = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: point, mouseButton: button)
      upEvent?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      post(upEvent, modifiers)
      if n < clickCount { usleep(CLICK_HOLD_US) }
    }
  }

  func drag(from: CGPoint, to: CGPoint, modifiers: CGEventFlags) {
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left), modifiers)
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left), modifiers)
    // Intermediate moves matter: a single jump from press to release is a click at the destination
    // for most drag implementations, which watch for movement to decide a drag has begun.
    let steps = 12
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
      post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left), modifiers)
      usleep(8_000)
    }
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left), modifiers)
  }

  /// Scroll at a point. The pointer is moved there first because a scroll event is delivered to
  /// whatever is under the cursor, not to whatever has focus — scrolling "the element" means
  /// putting the cursor on it.
  func scroll(at point: CGPoint, dx: Int32, dy: Int32) {
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left), CGEventFlags())
    post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0), CGEventFlags())
  }

  /// Type literal text.
  ///
  /// `keyboardSetUnicodeString` on a keycode-0 event, rather than a sequence of real keycodes: it
  /// hands the string to the app directly, so it is layout-independent, needs no dead-key handling,
  /// and can type characters the physical keyboard has no key for.
  ///
  /// Chunked in UTF-16 UNITS, which is what the API counts — not in Characters, which is what a
  /// reader counts. One emoji is a single Character and two UTF-16 units, so chunking by Character
  /// would put twice the intended payload in an event for exactly the text most likely to overflow
  /// it. Chunks are still cut on Character boundaries so a surrogate pair is never split across two
  /// events, which would deliver two replacement characters instead of the emoji.
  func type(_ text: String) {
    for chunk in chunk(text, 16) {
      let units = Array(chunk.utf16)
      guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { continue }
      down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
      // Apps that re-render on every keystroke (editors, web views) drop input posted faster than
      // they can consume it. This is the difference between typing a sentence and typing a third of one.
      usleep(6_000)
    }
  }

  func press(keycode: CGKeyCode, modifiers: CGEventFlags) {
    post(CGEvent(keyboardEventSource: source, virtualKey: keycode, keyDown: true), modifiers)
    usleep(CLICK_HOLD_US)
    post(CGEvent(keyboardEventSource: source, virtualKey: keycode, keyDown: false), modifiers)
  }

  /// Modifiers ride on the event's own `flags` rather than being bracketed with separate
  /// flagsChanged events. Both work for AppKit; only this one is atomic, so an interleaved real
  /// keystroke from the user cannot land inside a synthetic chord and pick up its modifiers.
  private func post(_ event: CGEvent?, _ modifiers: CGEventFlags) {
    guard let event else { return }
    if !modifiers.isEmpty { event.flags = modifiers }
    event.post(tap: .cghidEventTap)
  }

  /// Split into pieces of at most `units` UTF-16 units, never splitting a Character. A single
  /// Character longer than the budget (a flag emoji, a family sequence) still goes out whole rather
  /// than being cut into meaningless halves.
  private func chunk(_ s: String, _ units: Int) -> [String] {
    var out: [String] = []
    var current = ""
    var currentUnits = 0
    for character in s {
      let width = character.utf16.count
      if currentUnits > 0, currentUnits + width > units {
        out.append(current)
        current = ""
        currentUnits = 0
      }
      current.append(character)
      currentUnits += width
    }
    if !current.isEmpty { out.append(current) }
    return out
  }
}

// ── Targeting ───────────────────────────────────────────────────────────────────────────────────

/// The app whose window is really on top at `point`, when that is NOT `target`. Nil means the target
/// owns the point (or nothing does, which the caller treats separately).
///
/// This is the check that makes synthetic clicking safe. Coordinates always hit whatever is actually
/// in front, so the only honest way to click "the Save button in TextEdit" is to confirm TextEdit is
/// what is under that point at the instant of the click. Activation is asynchronous and cooperative —
/// an app can decline to come forward, and a modal from a THIRD app can sit on top of it.
///
/// `CGWindowListCopyWindowInfo` returns bounds and owner pids WITHOUT the Screen Recording grant
/// (only titles and pixels are gated — with the grant off, windows still come back with full bounds
/// and owner pids while `kCGWindowName` is withheld). So this works on a machine that has granted
/// only Accessibility, which is the configuration to expect.
///
/// **The layer filter is not optional.** Normal application windows live at layer 0; everything
/// above is system or floating chrome. Measured on an ordinary desktop:
///
///     layer 24  Window Server        the menu bar
///     layer 21  Notification Center  a full-screen, alpha-1.0 window present at ALL times
///     layer  8  Raycast              a launcher panel
///     layer  0  Chrome, Messages, Ghostty, System Settings
///
/// Notification Center is why this exists: its permanently-present full-screen window contains every
/// point on the display, so a naive front-to-back hit test names it the owner of every pixel and
/// refuses every click on the machine. Windows above layer 0 are therefore skipped unless they belong
/// to the target itself — which keeps the target's own menus and popovers (layer 101 and friends)
/// clickable, while ignoring overlays that belong to nobody in this conversation.
///
/// What that filter gives up: a full-screen overlay from a third app (a launcher palette, a
/// screen-share banner) sits above the point and is not seen here. That case is covered by the OTHER
/// check — such an overlay is frontmost by definition, so the target never becomes active and
/// `raise` refuses before this is ever consulted.
private func occludingApp(at point: CGPoint, target: pid_t) -> NSRunningApplication? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  // Front-to-back, so the first window that both contains the point and counts is the one a click
  // would reach.
  for window in list {
    guard let owner = window[kCGWindowOwnerPID as String] as? pid_t else { continue }
    let layer = window[kCGWindowLayer as String] as? Int ?? 0
    if layer != 0 && owner != target { continue }
    guard let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
          bounds.contains(point) else { continue }
    return owner == target ? nil : NSRunningApplication(processIdentifier: owner)
  }
  return nil
}

// ── The helper ──────────────────────────────────────────────────────────────────────────────────

private final class Helper {
  private let snapshots = Snapshots()
  private let input = Input()
  /// The bundle identifier of the app that owns this helper — Realm — shared with its renderer, GPU
  /// and utility children.
  ///
  /// Derived from the PROCESS ANCESTRY rather than accepted as an argument: the one thing this
  /// helper must never be talked into is driving the app that owns it, and a value arriving over the
  /// same pipe as the commands is a value that whoever controls the commands also controls. The
  /// ancestor chain cannot be influenced from the far side of stdin.
  ///
  /// It walks up rather than reading `getppid()` once because the immediate parent is not reliably
  /// the app: under `pnpm dev`, and any time the helper is launched through a shell, the parent is a
  /// non-GUI process that `NSRunningApplication` does not know, and a single hop would resolve to
  /// nil — leaving Realm drivable by Realm. Verified against both shapes (direct child of Electron
  /// main; grandchild via a shell).
  private let selfBundleId: String?

  init() {
    selfBundleId = Helper.owningBundleId()
  }

  private static func owningBundleId() -> String? {
    var pid = getppid()
    // A short chain: the depth that matters is 1 (packaged) or 2-3 (a shell in between). The bound
    // exists so a pid cycle or a reparented orphan cannot spin here, not because deep nesting is real.
    for _ in 0..<8 {
      if pid <= 1 { return nil }
      if let app = NSRunningApplication(processIdentifier: pid), let bundleId = app.bundleIdentifier { return bundleId }
      guard let parent = Helper.parentPid(of: pid) else { return nil }
      pid = parent
    }
    return nil
  }

  /// A pid's parent, via `sysctl(KERN_PROC_PID)`. There is no Foundation API for this.
  private static func parentPid(of pid: pid_t) -> pid_t? {
    var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    guard sysctl(&name, UInt32(name.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
    let parent = info.kp_eproc.e_ppid
    return parent == pid ? nil : parent
  }

  func handle(method: String, params: [String: Any]) throws -> [String: Any] {
    switch method {
    case "ping": return ping()
    case "requestTrust": return requestTrust(params)
    case "listApps": return try listApps()
    case "snapshot": return try snapshot(params)
    case "act": return try act(params)
    default: throw HelperError("unknown method \"\(method)\"")
    }
  }

  // ── read-only ──

  /// Both grants, queried without prompting for either. `AXIsProcessTrusted` is the no-prompt form
  /// (its `WithOptions` sibling is the one that asks); `CGPreflightScreenCaptureAccess` is
  /// documented as a status read.
  private func ping() -> [String: Any] {
    ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
  }

  /// Raise a real macOS consent prompt. The ONLY method here that can produce a system dialog, and
  /// it is reached only from an explicit click in Realm's Settings — never from a tool call.
  ///
  /// One grant per call (`what`), because the two are asked for from separate rows and raising both
  /// dialogs at once stacks them on top of each other.
  ///
  /// It returns the state as it stands immediately afterwards, which for Accessibility will still be
  /// false: macOS shows a non-blocking dialog whose only button deep-links to System Settings, and
  /// the grant does not land until the user flips the switch there. There is no callback and nothing
  /// to await — the caller re-probes.
  private func requestTrust(_ params: [String: Any]) -> [String: Any] {
    switch params["what"] as? String {
    case "accessibility":
      let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(options)
    case "screenRecording":
      // There is no "ask" API for Screen Recording. This one prompts the first time and is a silent
      // no-op ever after, so a user who has already refused sees nothing and must use Settings.
      _ = CGRequestScreenCaptureAccess()
    default:
      break
    }
    return ping()
  }

  /// Deliberately NOT behind `requireTrust`. Enumerating running apps is `NSWorkspace`, not the
  /// accessibility API, and it works with no grant at all — so an agent on an ungranted machine can
  /// still discover what is running, and the grant error arrives at `snapshot`, attached to the
  /// thing that actually needed it. Gating it here would turn "you need to grant Accessibility" into
  /// "computer control is broken", which is a worse thing to tell someone.
  private func listApps() throws -> [String: Any] {
    // `.regular` only: the activation policy that means "has a Dock icon and windows". Accessory and
    // prohibited apps are menu-bar items and background daemons — dozens of them, none of which an
    // agent can meaningfully drive.
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    let rows: [[String: Any]] = apps.compactMap { app in
      let bundleId = app.bundleIdentifier ?? ""
      if isForbidden(bundleId: bundleId) { return nil }
      return [
        "pid": Int(app.processIdentifier),
        "bundleId": bundleId,
        "name": app.localizedName ?? bundleId,
        "frontmost": app.isActive,
        "hidden": app.isHidden,
      ]
    }
    // Reported alongside, so the caller never has to guess whether an empty-looking result means
    // "nothing is running" or "nothing is permitted".
    return ["apps": rows, "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
  }

  private func snapshot(_ params: [String: Any]) throws -> [String: Any] {
    try requireTrust()
    let app = try resolveApp(params)
    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)
    // Set BEFORE the first read. The timeout applies to every message sent to this application, and
    // the walk below is thousands of them.
    AXUIElementSetMessagingTimeout(axApp, AX_TIMEOUT_SECONDS)

    let (elements, truncated) = walk(app: axApp)
    if elements.isEmpty {
      // Distinguishable from a legitimately empty app: a trusted client reading a real app always
      // sees at least a window. Empty almost always means the app has no open window.
      throw HelperError("\(app.localizedName ?? "that app") exposed no accessible windows — it may have none open, or it may not implement the accessibility API")
    }
    let id = "ax_" + UUID().uuidString.prefix(8).lowercased()
    snapshots.store(Snapshot(id: id, pid: pid, bundleId: app.bundleIdentifier ?? "", appName: app.localizedName ?? "", elements: elements))

    var result: [String: Any] = [
      "snapshotId": id,
      "pid": Int(pid),
      "bundleId": app.bundleIdentifier ?? "",
      "appName": app.localizedName ?? "",
      "frontmost": app.isActive,
      "truncated": truncated,
      "elements": elements.map(\.wire),
    ]
    if (params["screenshot"] as? Bool) ?? false, let jpeg = captureApp(pid: pid) {
      result["screenshot"] = jpeg
    }
    return result
  }

  // ── mutating ──

  private func act(_ params: [String: Any]) throws -> [String: Any] {
    try requireTrust()
    guard let snapshotId = params["snapshotId"] as? String else { throw HelperError("act needs a snapshotId") }
    guard let kind = params["kind"] as? String else { throw HelperError("act needs a kind") }
    guard let snapshot = snapshots.app(snapshotId: snapshotId) else { throw Snapshots.staleError(snapshotId) }
    guard let app = NSRunningApplication(processIdentifier: snapshot.pid) else {
      snapshots.forget(pid: snapshot.pid)
      throw HelperError("\(snapshot.appName) has quit since that snapshot was taken", code: "stale_snapshot")
    }
    try refuseForbidden(bundleId: snapshot.bundleId)

    let element = try (params["index"] as? Int).map { try snapshots.resolve(snapshotId: snapshotId, index: $0) }
    if let element { try refuseSecureField(element, kind: kind) }

    // setValue and the AX actions go through the accessibility API rather than through synthetic
    // input, so they neither need nor take the app's focus. Everything below them does.
    switch kind {
    case "setValue":
      guard let element else { throw HelperError("setValue needs an element index") }
      guard let text = params["text"] as? String else { throw HelperError("setValue needs text") }
      return try setValue(element, text)
    case "menu":
      guard let element else { throw HelperError("menu needs an element index") }
      return try performAxAction(element, kAXShowMenuAction as String, described: "opened the context menu for")
    default:
      break
    }

    let point = try resolveActionPoint(app: app, element: element, params: params)
    let modifiers = input.flags(for: (params["modifiers"] as? [String]) ?? [])

    switch kind {
    case "click":
      let button: CGMouseButton = switch (params["button"] as? String) ?? "left" {
      case "right": .right
      case "middle": .center
      default: .left
      }
      input.click(at: point, button: button, clickCount: (params["clickCount"] as? Int) ?? 1, modifiers: modifiers)
      return ["ok": true, "detail": describe(element, verb: "clicked", snapshot: snapshot, point: point)]
    case "type":
      guard let text = params["text"] as? String, !text.isEmpty else { throw HelperError("type needs text") }
      if element != nil { focusElement(at: point) }
      input.type(text)
      return ["ok": true, "detail": describe(element, verb: "typed into", snapshot: snapshot, point: point)]
    case "key":
      guard let key = params["key"] as? String else { throw HelperError("key needs a key name") }
      if element != nil { focusElement(at: point) }
      input.press(keycode: try input.keycode(for: key), modifiers: modifiers)
      return ["ok": true, "detail": "pressed \(key) in \(snapshot.appName)"]
    case "scroll":
      let dx = Int32((params["dx"] as? Int) ?? 0)
      let dy = Int32((params["dy"] as? Int) ?? 0)
      input.scroll(at: point, dx: dx, dy: dy)
      return ["ok": true, "detail": describe(element, verb: "scrolled", snapshot: snapshot, point: point)]
    case "drag":
      guard let toIndex = params["toIndex"] as? Int else { throw HelperError("drag needs a toIndex") }
      let target = try snapshots.resolve(snapshotId: snapshotId, index: toIndex)
      let destination = try livePoint(target)
      try assertOwner(app: app, point: destination)
      input.drag(from: point, to: destination, modifiers: modifiers)
      return ["ok": true, "detail": "dragged onto \(label(target)) in \(snapshot.appName)"]
    default:
      throw HelperError("unknown act kind \"\(kind)\"")
    }
  }

  /// Realm never puts characters into a password field, in any mode — the same rule the browser
  /// tools apply, for the same reason: no per-action prompt can describe what a secret entering an
  /// unknown app means, and there is no mode in which getting it wrong is recoverable.
  ///
  /// The role is re-read from the LIVE element rather than taken from the snapshot. A snapshot's
  /// role is a claim about the past, and the sign-in sheet that replaced the form since then is
  /// exactly the case worth catching. Clicking a secure field is still allowed: giving it focus is
  /// how the user gets to type into it themselves.
  private func refuseSecureField(_ element: Element, kind: String) throws {
    guard ["type", "key", "setValue"].contains(kind) else { return }
    let liveRole = axString(element.handle, kAXRoleAttribute as String) ?? element.role
    guard liveRole == "AXSecureTextField" else { return }
    throw HelperError("refused: that is a password field. Realm never types into one — tell the user what to enter and let them type it", code: "secure_field")
  }

  private func setValue(_ element: Element, _ text: String) throws -> [String: Any] {
    var settable: DarwinBoolean = false
    AXUIElementIsAttributeSettable(element.handle, kAXValueAttribute as CFString, &settable)
    guard settable.boolValue else {
      throw HelperError("\(label(element)) will not accept a value directly — click it and type instead")
    }
    let status = AXUIElementSetAttributeValue(element.handle, kAXValueAttribute as CFString, text as CFTypeRef)
    guard status == .success else { throw axFailure(status, element) }
    return ["ok": true, "detail": "set the value of \(label(element))"]
  }

  private func performAxAction(_ element: Element, _ action: String, described verb: String) throws -> [String: Any] {
    guard element.actions.contains(action) else {
      throw HelperError("\(label(element)) has no \(action) action — it offers: \(element.actions.joined(separator: ", "))")
    }
    let status = AXUIElementPerformAction(element.handle, action as CFString)
    guard status == .success else { throw axFailure(status, element) }
    return ["ok": true, "detail": "\(verb) \(label(element))"]
  }

  // ── targeting helpers ──

  /// Bring the target app forward, resolve the point to act on, and refuse unless that point is
  /// really over the target app.
  ///
  /// The order is the safety property: activate, wait for it to land, re-read the element's frame
  /// from the LIVE element (a window that just came forward has usually moved or resized), then
  /// hit-test. An element's coordinates from snapshot time are a hypothesis; the frame read here is
  /// the fact.
  private func resolveActionPoint(app: NSRunningApplication, element: Element?, params: [String: Any]) throws -> CGPoint {
    try raise(app)
    let point: CGPoint
    if let element {
      point = try livePoint(element)
    } else if let x = params["x"] as? Double, let y = params["y"] as? Double {
      point = CGPoint(x: x, y: y)
    } else {
      throw HelperError("an act needs either an element index or x/y coordinates")
    }
    try assertOwner(app: app, point: point)
    return point
  }

  private func raise(_ app: NSRunningApplication) throws {
    if app.isActive { return }
    app.activate(options: [])
    let deadline = Date().addingTimeInterval(Double(ACTIVATE_TIMEOUT_MS) / 1000)
    while Date() < deadline {
      // The run loop has to turn for AppKit to process the activation it just requested; a bare
      // sleep here never sees `isActive` flip.
      RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
      if app.isActive { return }
    }
    throw HelperError("\(app.localizedName ?? "the app") did not come to the front when asked, so a click there could land on another window", code: "not_frontmost")
  }

  /// The element's CURRENT centre. Re-read at act time, never taken from the snapshot: between the
  /// snapshot and the click the window may have moved, the list may have scrolled, or the element
  /// may have been destroyed — and only the last of those is detectable any other way.
  private func livePoint(_ element: Element) throws -> CGPoint {
    guard let frame = axFrame(element.handle) else {
      throw HelperError("\(label(element)) is gone from the screen — take a fresh snapshot", code: "stale_snapshot")
    }
    guard frame.width >= 1, frame.height >= 1 else {
      throw HelperError("\(label(element)) is no longer visible — take a fresh snapshot", code: "stale_snapshot")
    }
    return CGPoint(x: frame.midX, y: frame.midY)
  }

  private func assertOwner(app: NSRunningApplication, point: CGPoint) throws {
    guard let blocker = occludingApp(at: point, target: app.processIdentifier) else { return }
    let other = blocker.localizedName ?? "another app"
    throw HelperError("refused: \(other)'s window is in front of \(app.localizedName ?? "the target") at that point, so the click would have gone to it", code: "occluded")
  }

  private func requireTrust() throws {
    guard AXIsProcessTrusted() else {
      throw HelperError("Realm is not a trusted accessibility client — grant Accessibility in Realm's Settings before using computer control", code: "no_accessibility")
    }
  }

  /// Refusal is by BUNDLE ID, not by pid: Realm is several processes (main, renderer, GPU, the
  /// server child) and only one of them is this helper's ancestor, but they all share a bundle id and
  /// all of them draw Realm's windows — including the window a permission card appears in.
  private func isForbidden(bundleId: String) -> Bool {
    if FORBIDDEN_BUNDLE_IDS.contains(bundleId) { return true }
    if let selfBundleId, !selfBundleId.isEmpty, bundleId == selfBundleId { return true }
    return false
  }

  private func refuseForbidden(bundleId: String) throws {
    guard isForbidden(bundleId: bundleId) else { return }
    throw HelperError("refused: \(bundleId.isEmpty ? "that app" : bundleId) is never driveable — Realm will not drive itself, System Settings, or a password prompt", code: "forbidden_app")
  }

  private func resolveApp(_ params: [String: Any]) throws -> NSRunningApplication {
    let running = NSWorkspace.shared.runningApplications
    var app: NSRunningApplication?
    if let pid = params["pid"] as? Int {
      app = running.first { $0.processIdentifier == pid_t(pid) }
      if app == nil { throw HelperError("no running app with pid \(pid)") }
    } else if let bundleId = params["bundleId"] as? String {
      app = running.first { $0.bundleIdentifier == bundleId && $0.activationPolicy == .regular }
      if app == nil { throw HelperError("\(bundleId) is not running — list_apps shows what is") }
    } else {
      app = running.first { $0.isActive && $0.activationPolicy == .regular }
      if app == nil { throw HelperError("no app is frontmost") }
    }
    guard let resolved = app else { throw HelperError("no such application") }
    try refuseForbidden(bundleId: resolved.bundleIdentifier ?? "")
    return resolved
  }

  private func axFailure(_ status: AXError, _ element: Element) -> HelperError {
    switch status {
    case .invalidUIElement, .cannotComplete:
      return HelperError("\(label(element)) no longer exists — take a fresh snapshot", code: "stale_snapshot")
    case .attributeUnsupported, .actionUnsupported:
      return HelperError("\(label(element)) does not support that")
    default:
      return HelperError("the accessibility API refused that (\(status.rawValue))")
    }
  }

  /// Give an element keyboard focus before typing into it, by clicking it. Without this, text goes
  /// wherever focus already was — which after a snapshot is usually the last thing the USER touched.
  /// The pause afterwards is for the app to process the click and move its caret; typing into a field
  /// that has not finished becoming first responder loses the leading characters.
  private func focusElement(at point: CGPoint) {
    input.click(at: point, button: .left, clickCount: 1, modifiers: CGEventFlags())
    usleep(60_000)
  }

  private func label(_ element: Element) -> String {
    element.name.isEmpty ? "the \(element.role) at index \(element.index)" : "\"\(element.name)\""
  }

  private func describe(_ element: Element?, verb: String, snapshot: Snapshot, point: CGPoint) -> String {
    guard let element else { return "\(verb) at (\(Int(point.x)), \(Int(point.y))) in \(snapshot.appName)" }
    return "\(verb) \(label(element)) in \(snapshot.appName)"
  }
}

// ── Loop ────────────────────────────────────────────────────────────────────────────────────────

private let helper = Helper()
writeLine(["ready": true])

// Synchronous line-at-a-time on the main thread. Requests are strictly serial by design: two
// concurrent acts would race over which app is frontmost and where the pointer is, and there is no
// meaningful answer to "click these two things at once". `readLine` returning nil is the parent
// closing the pipe.
while let line = readLine(strippingNewline: true) {
  if line.isEmpty { continue }
  guard let data = line.data(using: .utf8),
        let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let id = message["id"] else {
    writeLine(["id": NSNull(), "error": ["message": "unparseable request", "code": "bad_request"]])
    continue
  }
  let method = (message["method"] as? String) ?? ""
  let params = (message["params"] as? [String: Any]) ?? [:]
  do {
    writeLine(["id": id, "result": try helper.handle(method: method, params: params)])
  } catch let error as HelperError {
    writeLine(["id": id, "error": ["message": error.message, "code": error.code]])
  } catch {
    writeLine(["id": id, "error": ["message": error.localizedDescription, "code": "failed"]])
  }
}
