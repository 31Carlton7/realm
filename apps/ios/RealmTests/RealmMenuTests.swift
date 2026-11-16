import RealmKit
import SwiftUI
import Testing
import UIKit
@testable import Realm

/// Realm's own menu keeps what the system menu gave for free: it opens beside its control and never
/// over it, a touch outside puts it away, it opens with a haptic, VoiceOver reads it as a menu and
/// stays in it, and at the largest text sizes every word is whole.
@MainActor
@Suite("Realm's menu", .serialized)
struct RealmMenuTests {
    /// The Pro Max's screen inside its safe area.
    static let room = CGRect(x: 0, y: 62, width: 440, height: 956 - 62 - 34)

    @Test func itNeverCoversItsControl() {
        let sizes = [CGSize(width: 250, height: 140), CGSize(width: 300, height: 420), CGSize(width: 416, height: 2_000)]
        for size in sizes {
            for y in stride(from: Self.room.minY, through: Self.room.maxY - 44, by: 37) {
                for x in stride(from: 8.0, through: 388, by: 95) {
                    let anchor = CGRect(x: x, y: y, width: 44, height: 44)
                    let frame = RealmMenuPlacement.frame(size: size, anchor: anchor, room: Self.room)
                    #expect(frame.intersection(anchor).isNull || frame.intersection(anchor).height == 0,
                            "\(size) from \(anchor) covers it: \(frame)")
                    #expect(frame.minY >= Self.room.minY && frame.maxY <= Self.room.maxY, "\(size) from \(anchor): \(frame)")
                    #expect(frame.minX >= Self.room.minX + RealmMenuPlacement.margin - 0.5
                            && frame.maxX <= Self.room.maxX - RealmMenuPlacement.margin + 0.5, "\(size) from \(anchor): \(frame)")
                }
            }
        }
    }

    /// Below the control where it fits, above it where only that side has room, and when neither does, on
    /// the roomier side as tall as that side allows, so its rows scroll.
    @Test func itOpensWholeOnOneSide() {
        let size = CGSize(width: 260, height: 300)
        let bar = CGRect(x: 380, y: 70, width: 44, height: 44)
        let below = RealmMenuPlacement.frame(size: size, anchor: bar, room: Self.room)
        #expect(below.minY == bar.maxY + RealmMenuPlacement.gap && below.height == 300)
        #expect(below.maxX == bar.maxX, "lines up with the control's trailing edge: \(below)")
        let composer = CGRect(x: 16, y: 850, width: 44, height: 44)
        let above = RealmMenuPlacement.frame(size: size, anchor: composer, room: Self.room)
        #expect(above.maxY == composer.minY - RealmMenuPlacement.gap && above.height == 300)
        #expect(above.minX == composer.minX, "lines up with the control's leading edge: \(above)")
        let tall = RealmMenuPlacement.frame(size: CGSize(width: 260, height: 2_000), anchor: composer, room: Self.room)
        #expect(tall.maxY == composer.minY - RealmMenuPlacement.gap)
        #expect(tall.minY == Self.room.minY, "takes the room above, and scrolls: \(tall)")
    }

    /// At the accessibility sizes the label is drawn twice, once for the large-content viewer off screen;
    /// the menu opens from the copy in a window, whichever was drawn last.
    @Test func itOpensFromTheControlOnScreen() throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let onScreen = UIView()
        window.addSubview(onScreen)
        let offScreen = UIView()
        let anchor = MenuAnchor()
        anchor.add(onScreen)
        anchor.add(offScreen)
        #expect(anchor.view === onScreen)
    }

    /// A menu open over a screen, from a control at its middle.
    static func opened(_ haptics: inout Int) throws -> (window: UIWindow, menu: UIWindow, controller: RealmMenuController) {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 440, height: 956)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        let counter = Counter()
        RealmMenuHost.shared.haptic = { counter.count += 1 }
        RealmMenuHost.shared.present(title: "Mode", anchor: CGRect(x: 200, y: 400, width: 44, height: 44), over: window) {
            Section(head: "Mode") {
                Toggle(isOn: .constant(true)) { Label("Build", systemImage: "hammer") }
                Toggle(isOn: .constant(false)) { Label("Plan", systemImage: "list.bullet.clipboard") }
            }
        }
        let menu = try #require(RealmMenuHost.shared.window)
        let controller = try #require(menu.rootViewController as? RealmMenuController)
        controller.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        haptics = counter.count
        return (window, menu, controller)
    }

    final class Counter { var count = 0 }

    @Test func aTouchOutsidePutsItAway() throws {
        var haptics = 0
        let (window, menu, controller) = try Self.opened(&haptics)
        defer { window.isHidden = true }
        let panel = controller.host.view.frame
        #expect(panel.minY > 444 || panel.maxY < 400, "beside the control, not over it: \(panel)")
        let inside = CGPoint(x: panel.midX, y: panel.midY)
        #expect(menu.hitTest(inside, with: nil)?.isDescendant(of: controller.host.view) == true)
        // A tap, or the start of a swipe, anywhere outside it lands on the backdrop.
        for outside in [CGPoint(x: 20, y: 120), CGPoint(x: 420, y: 900), CGPoint(x: 222, y: 422)] {
            #expect(menu.hitTest(outside, with: nil) === controller.backdrop, "\(outside)")
        }
        controller.backdrop.sendActions(for: .touchDown)
        #expect(RealmMenuHost.shared.window == nil)
    }

    @Test func itOpensWithAHaptic() throws {
        var haptics = 0
        let (window, _, _) = try Self.opened(&haptics)
        defer { window.isHidden = true; RealmMenuHost.shared.dismiss(fading: false) }
        #expect(haptics == 1)
    }

    /// VoiceOver stays inside the menu, reads its rows as buttons and the chosen one as selected, says
    /// the control opens a menu, and offers Close menu outside it as the system's does.
    @Test func voiceOverReadsItAsAMenu() throws {
        var haptics = 0
        let (window, _, controller) = try Self.opened(&haptics)
        defer { window.isHidden = true; RealmMenuHost.shared.dismiss(fading: false) }
        #expect(controller.view.accessibilityViewIsModal)
        #expect(controller.backdrop.isAccessibilityElement && controller.backdrop.accessibilityLabel == "Close menu")
        #expect(controller.backdrop.accessibilityTraits.contains(.button))
        #expect(RealmMenu<EmptyView, EmptyView>.spokenHint(nil) == "Opens a menu.")
        #expect(RealmMenu<EmptyView, EmptyView>.spokenHint("Changes what the agent may do") == "Changes what the agent may do. Opens a menu.")
        let elements = Self.elements(in: controller.host.view)
        let build = try #require(elements.first { $0.accessibilityLabel == "Build" }, "\(elements.map(\.accessibilityLabel))")
        #expect(build.accessibilityTraits.contains(.button) && build.accessibilityTraits.contains(.selected))
        let plan = try #require(elements.first { $0.accessibilityLabel == "Plan" })
        #expect(plan.accessibilityTraits.contains(.button) && !plan.accessibilityTraits.contains(.selected))
        #expect(elements.contains { $0.accessibilityLabel == "Mode" && $0.accessibilityTraits.contains(.header) })
    }

    /// An open menu follows the screen to the other face: its card is the dark surface once the screen is dark.
    @Test func itFollowsTheScreensFace() throws {
        var haptics = 0
        let (window, menu, controller) = try Self.opened(&haptics)
        defer { window.isHidden = true; RealmMenuHost.shared.dismiss(fading: false) }
        func card(_ style: UIUserInterfaceStyle) throws -> CGFloat {
            menu.overrideUserInterfaceStyle = style
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
            let view = try #require(controller.host.view)
            let image = UIGraphicsImageRenderer(bounds: view.bounds).image { _ in _ = view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
            // A point on the card beside the head, clear of every word.
            let point = CGRect(x: (view.bounds.maxX - 30) * image.scale, y: 12 * image.scale, width: 1, height: 1)
            let pixel = try #require(image.cgImage?.cropping(to: point))
            return try #require(UIImage(cgImage: pixel).white)
        }
        #expect(try card(.light) > 0.9)
        #expect(try card(.dark) < 0.3)
    }

    /// Every element VoiceOver can reach under a view.
    /// SwiftUI builds its accessibility tree only for a client that asks; with no VoiceOver or reader
    /// attached (a fresh simulator) it reads empty. This turns on the automation the UI tests use, and
    /// gives the tree a moment to build.
    static func elements(in view: NSObject) -> [NSObject] {
        if let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
           let symbol = dlsym(library, "_AXSSetAutomationEnabled") {
            unsafeBitCast(symbol, to: (@convention(c) (Int32) -> Void).self)(1)
        }
        for _ in 0..<20 {
            let found = collect(in: view)
            if !found.isEmpty { return found }
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        }
        return []
    }

    private static func collect(in view: NSObject) -> [NSObject] {
        var found: [NSObject] = []
        var queue: [NSObject] = [view]
        while let next = queue.popLast() {
            if next.isAccessibilityElement, next !== view { found.append(next) }
            if let children = next.accessibilityElements as? [NSObject] {
                queue.append(contentsOf: children)
            } else if let view = next as? UIView {
                queue.append(contentsOf: view.subviews)
            }
        }
        return found
    }

    /// With the keyboard up, the menu's room ends at the keyboard's top, so a menu from the composer opens
    /// above it rather than under it.
    @Test func aMenuKeepsClearOfTheKeyboard() throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 440, height: 956)
        let controller = RealmMenuController(panel: AnyView(Color.clear.frame(width: 250, height: 100)),
                                             anchor: CGRect(x: 16, y: 560, width: 44, height: 44),
                                             keyboard: CGRect(x: 0, y: 620, width: 440, height: 336)) {}
        window.rootViewController = controller
        window.isHidden = false
        defer { window.isHidden = true }
        controller.view.layoutIfNeeded()
        #expect(controller.room.maxY == 620, "\(controller.room)")
        #expect(controller.host.view.frame.maxY <= 560, "above the control, clear of the keyboard: \(controller.host.view.frame)")
    }

    /// The profile switcher is the whole title, at least a touch tall (the audit's HOME-08: 63 by 18).
    @Test func theProfileSwitcherIsATouchTall() {
        for size in [DynamicTypeSize.xSmall, .large, .accessibility5] {
            let title = ProfileTitle(name: "Personal", subtitle: Text("On Carlton's Mac")).dynamicTypeSize(size)
            let fitted = UIHostingController(rootView: title).sizeThatFits(in: CGSize(width: 300, height: 400))
            #expect(fitted.height >= 44 && fitted.width >= 120, "\(size): \(fitted)")
        }
    }

    /// The Mode menu draws its two heads, which iOS's menu dropped (the audit's COMP-08).
    @Test func theModeMenuDrawsItsHeads() throws {
        let rows = ModeMenuRows(options: SettingWordsTests.options("default")) { _, _ in }
        let words = try Drawing.words(RealmMenuPanel(title: "Mode", close: MenuClose {}, content: rows), width: 300, dark: false)
        for word in ["Mode", "Build", "Plan", "Permissions", "Ask each time", "Accept edits", "Full access"] {
            #expect(words.contains(word), "\(word) in \(words)")
        }
    }

    /// At the accessibility sizes the menu's words grow and wrap inside the screen's width, whole.
    @Test func everyWordIsWholeAtTheLargestSizes() throws {
        let rows = ModeMenuRows(options: SettingWordsTests.options("default")) { _, _ in }
        for size in LargeTextTests.sizes {
            for dark in [false, true] {
                let words = try Drawing.words(RealmMenuPanel(title: "Mode", close: MenuClose {}, content: rows),
                                              width: 416, dark: dark, size: size)
                // "Ask" and "each" apart: Vision on iOS 26.5 runs the row's words together ("Askeachv").
                for word in ["Permissions", "Ask", "each", "Accept", "Full access"] {
                    #expect(words.contains(word), "\(size) \(dark ? "dark" : "light"): \(word) in \(words)")
                }
            }
        }
    }

    /// Taller than its room at the largest size, the menu keeps to the room and scrolls inside its card.
    @Test func aMenuTallerThanItsRoomScrolls() throws {
        let rows = ModeMenuRows(options: SettingWordsTests.options("default")) { _, _ in }
        let panel = RealmMenuPanel(title: "Mode", close: MenuClose {}, content: rows).dynamicTypeSize(.accessibility5)
        let whole = UIHostingController(rootView: panel).sizeThatFits(in: CGSize(width: 416, height: 10_000))
        #expect(whole.height > 500, "\(whole)")
        #expect(whole.width <= 416, "\(whole)")
        let kept = UIHostingController(rootView: panel).sizeThatFits(in: CGSize(width: 416, height: 300))
        #expect(kept.height <= 300, "\(kept)")
    }

    /// A session's More at AX5, opened from the bar, is taller than the screen: the card keeps to the room
    /// under the bar and scrolls inside itself, and Delete, its last row, is in VoiceOver's reach and
    /// comes into the card when it is scrolled to the end.
    @Test func everyRowOfALongMenuCanBeReached() throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 440, height: 956)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        defer { window.isHidden = true; RealmMenuHost.shared.dismiss(fading: false) }
        RealmMenuHost.shared.haptic = {}
        RealmMenuHost.shared.present(title: "More", anchor: CGRect(x: 388, y: 62, width: 44, height: 44), over: window) {
            Section { Button("Find in session", systemImage: "text.magnifyingglass") {} }
            Section {
                Button("Changes", systemImage: "plusminus") {}
                Button("Pull request", systemImage: "arrow.triangle.pull") {}
            }
            Section {
                ForEach([RowAction.pin, .rename, .archive, .fork, .moveToSpace, .switchAgent]) { action in
                    Button(action.title, systemImage: action.symbol) {}
                }
            }
            Section { Button("Delete", systemImage: "trash", role: .destructive) {} }
        }
        let menu = try #require(RealmMenuHost.shared.window)
        menu.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        let controller = try #require(menu.rootViewController as? RealmMenuController)
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))

        let card = controller.host.view.frame
        #expect(card.minY >= 106 && card.maxY <= window.bounds.maxY, "kept to the room under the bar: \(card)")
        let scroll = try #require(Self.scrollView(in: controller.host.view), "the card does not scroll")
        #expect(scroll.contentSize.height > scroll.bounds.height + 44, "\(scroll.contentSize) in \(scroll.bounds)")

        let delete = try #require(Self.elements(in: controller.host.view).first { $0.accessibilityLabel == "Delete" },
                                  "VoiceOver cannot reach Delete")
        #expect(delete.accessibilityTraits.contains(.button))
        scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentSize.height - scroll.bounds.height), animated: false)
        controller.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        let shown = controller.host.view.convert(controller.host.view.bounds, to: nil)
        #expect(shown.contains(delete.accessibilityFrame), "Delete at \(delete.accessibilityFrame), the card at \(shown)")
    }

    static func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
    }
}

private extension UIImage {
    /// How light a one-pixel image is, from black at 0 to white at 1.
    var white: CGFloat? {
        guard let cgImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        context?.draw(cgImage, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return CGFloat(Int(pixel[0]) + Int(pixel[1]) + Int(pixel[2])) / (3 * 255)
    }
}
