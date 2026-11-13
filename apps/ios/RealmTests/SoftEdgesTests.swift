import SwiftUI
import Testing
import UIKit
@testable import Realm

/// Where the soft edges stop. Each stage is white content on a black ground, so wherever the ground's
/// fade covers it the white goes grey. The system's own scroll edge effect is hidden on the stage: it is
/// the system's to draw, and what is measured here is Realm's fade.
@MainActor
@Suite("The soft edges", .serialized)
struct SoftEdgesTests {
    /// The fade runs out `feather` points past a bar, and a screen edge with no bar has none.
    @Test func theFadeEndsJustPastTheBar() {
        #expect(EdgeFade.depth(bar: 116) == 116 + EdgeFade.feather)
        #expect(EdgeFade.feather <= 8)
        #expect(EdgeFade.depth(bar: 0) == 0)
        let stops = EdgeFade.stops(height: EdgeFade.depth(bar: 116))
        // About half at the bar's inner edge, nothing at the fade's end.
        #expect(stops.contains { abs($0.location - 116 / 124) < 0.001 && $0.opacity == 0.55 })
        #expect(stops.last?.location == 1 && stops.last?.opacity == 0)
    }

    /// Under a session's bar, nothing past its edge and a short feather is dimmed, whichever way the
    /// keyboard is; at the foot, nothing above the composer's card is, so the chips and the transcript
    /// over them stay crisp.
    @Test(arguments: [0, 336] as [CGFloat])
    func aSessionsEdgesStopAtItsBarAndItsCard(keyboard: CGFloat) throws {
        let shot = try Shot(SessionStage(), keyboard: keyboard)
        let barBottom = try #require(shot.navigationBarBottom)
        let cardTop = try #require(shot.firstRow(from: 0, where: { $0.red > 200 && $0.green < 60 }, x: shot.width / 2))
        let gutter: CGFloat = 4
        // The most the design allows past a bar's edge: a literal, so a wider feather fails here.
        let feather: CGFloat = 8

        #expect(shot.at(x: gutter, y: barBottom - 2).white < 0.7, "no fade under the bar")
        let fadedPast = shot.lastRow(in: barBottom..<cardTop, x: gutter) { $0.white < 0.97 }
        #expect((fadedPast ?? barBottom) <= barBottom + feather,
                "the top fade reaches \((fadedPast ?? 0) - barBottom) pt past the bar (keyboard \(keyboard))")
        let fadedAbove = shot.firstRow(from: barBottom + feather + 1, where: { $0.white < 0.97 }, x: gutter)
        #expect((fadedAbove ?? cardTop) >= cardTop,
                "the foot's fade starts \(cardTop - (fadedAbove ?? cardTop)) pt above the card (keyboard \(keyboard))")
        #expect(shot.at(x: gutter, y: cardTop + 40).white < 0.6, "no fade beside the card")
    }

    /// A pinned head stands on its own ground and dims nothing under it.
    @Test func aPinnedHeadDimsNothingUnderIt() throws {
        let stage = ZStack(alignment: .top) {
            Color.white
            Text("Realm").frame(maxWidth: .infinity, minHeight: 40).pinnedOnGround()
        }
        .frame(width: 402, height: 200)
        .environment(\.colorScheme, .dark)
        let shot = try Shot(stage, size: CGSize(width: 402, height: 200), safeArea: false)
        #expect(shot.at(x: 4, y: 20).white < 0.3, "the head has no ground")
        #expect(shot.firstRow(from: 41, where: { $0.white < 0.97 }, x: 4) == nil, "the head dims the row under it")
    }
}

/// A session's shape: a bar with a two-line title, a scrolling transcript, and a foot of a chip row
/// over the composer's card.
private struct SessionStage: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                Color.white.frame(height: 3_000)
            }
            .softEdges(.top, ground: .black)
            .scrollEdgeEffectHidden(true, for: .all)
            .safeAreaBar(edge: .bottom) {
                VStack(spacing: 10) {
                    Color.clear.frame(height: 36)
                    Color(red: 1, green: 0, blue: 0).frame(height: 90)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                        .softFoot(ground: .black)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text("Scout").font(.headline)
                        Text("Working").font(.caption)
                    }
                }
            }
        }
        .background(Color.black)
        .environment(\.colorScheme, .dark)
    }
}

/// A view drawn full-screen in a window, read back pixel by pixel in points.
@MainActor
private struct Shot {
    struct Pixel {
        let red: Int, green: Int, blue: Int
        var white: Double { Double(min(red, green, blue)) / 255 }
    }

    let width: CGFloat
    let navigationBarBottom: CGFloat?
    private let bytes: [UInt8]
    private let pixelsWide: Int
    private let scale: CGFloat

    /// `keyboard` points at the foot are taken from the safe area, as the keyboard takes them.
    init(_ view: some View, size: CGSize? = nil, safeArea: Bool = true, keyboard: CGFloat = 0) throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: view)
        if !safeArea { host.safeAreaRegions = [] }
        host.additionalSafeAreaInsets.bottom = keyboard
        window.rootViewController = host
        if let size { window.frame = CGRect(origin: .zero, size: size) }
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        navigationBarBottom = Self.navigationBar(in: window).map { $0.convert($0.bounds, to: window).maxY }
        window.isHidden = true

        let cg = try #require(image.cgImage)
        width = window.bounds.width
        scale = CGFloat(cg.width) / window.bounds.width
        pixelsWide = cg.width
        var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
        let context = try #require(CGContext(data: &bytes, width: cg.width, height: cg.height, bitsPerComponent: 8,
                                             bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        self.bytes = bytes
    }

    var height: CGFloat { CGFloat(bytes.count / 4 / pixelsWide) / scale }

    func at(x: CGFloat, y: CGFloat) -> Pixel {
        let index = (Int(y * scale) * pixelsWide + Int(x * scale)) * 4
        return Pixel(red: Int(bytes[index]), green: Int(bytes[index + 1]), blue: Int(bytes[index + 2]))
    }

    /// The first point row at or below `start` whose pixel at `x` matches.
    func firstRow(from start: CGFloat, where matches: (Pixel) -> Bool, x: CGFloat) -> CGFloat? {
        stride(from: start.rounded(.up), to: height, by: 1).first { matches(at(x: x, y: $0)) }
    }

    /// The last point row in `range` whose pixel at `x` matches.
    func lastRow(in range: Range<CGFloat>, x: CGFloat, where matches: (Pixel) -> Bool) -> CGFloat? {
        stride(from: range.lowerBound.rounded(.up), to: range.upperBound, by: 1).reversed().first { matches(at(x: x, y: $0)) }
    }

    private static func navigationBar(in view: UIView) -> UINavigationBar? {
        if let bar = view as? UINavigationBar { return bar }
        return view.subviews.lazy.compactMap { navigationBar(in: $0) }.first
    }
}
