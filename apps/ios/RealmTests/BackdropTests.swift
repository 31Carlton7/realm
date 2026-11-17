import RealmKit
import SwiftUI
import Testing
import UIKit
@testable import Realm

/// The picture behind a session: every run of text reads over its worst pixel, in both faces; the
/// picture stays off where the person asked for less on screen; and a Mac or a network that cannot send
/// one leaves the plain ground.
@MainActor
@Suite("The picture behind a session", .serialized)
struct BackdropTests {
    nonisolated static let schemes: [ColorScheme] = [.light, .dark]
    static let treatments: [Backdrop.Treatment] = [.asIs, .colorKept, .printed(halftone: false), .printed(halftone: true)]

    /// The ratio each ink must keep over every pixel (design.md): 4.5:1 for the body, the quiet ink and
    /// the link, and 3:1 for the light face's link.
    static func needs(_ inks: Backdrop.Inks, _ scheme: ColorScheme) -> [(name: String, ink: Backdrop.RGB, need: Double)] {
        [("body", inks.ink, 4.5), ("quiet", inks.ink2, 4.5), ("link", inks.link, scheme == .light ? 3 : 4.5)]
    }

    /// Stills that ask the most of the guard: all white (the brightest), all black (the darkest),
    /// saturated hues, and a ramp through every grey beside every hue.
    static func stills() -> [(name: String, image: CGImage)] {
        func solid(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGImage {
            UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64), format: .init(for: .init(displayScale: 1))).image { c in
                UIColor(red: r, green: g, blue: b, alpha: 1).setFill()
                c.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
            }.cgImage!
        }
        let ramp = UIGraphicsImageRenderer(size: CGSize(width: 256, height: 64), format: .init(for: .init(displayScale: 1))).image { c in
            for x in 0..<256 {
                UIColor(white: CGFloat(x) / 255, alpha: 1).setFill()
                c.fill(CGRect(x: x, y: 0, width: 1, height: 32))
                UIColor(hue: CGFloat(x) / 255, saturation: 1, brightness: 1, alpha: 1).setFill()
                c.fill(CGRect(x: x, y: 32, width: 1, height: 32))
            }
        }.cgImage!
        return [("white", solid(1, 1, 1)), ("black", solid(0, 0, 0)), ("yellow", solid(1, 1, 0)), ("blue", solid(0, 0, 1)), ("ramp", ramp)]
    }

    /// The lowest ratio `ink` has over any pixel of `bytes` (RGBA).
    static func worst(_ ink: Backdrop.RGB, over bytes: [UInt8]) -> Double {
        var lowest = Double.infinity
        for i in stride(from: 0, to: bytes.count, by: 4) {
            let p = Backdrop.RGB(Double(bytes[i]) / 255, Double(bytes[i + 1]) / 255, Double(bytes[i + 2]) / 255)
            lowest = min(lowest, ink.contrast(with: p))
        }
        return lowest
    }

    static func bytes(_ image: CGImage) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        bytes.withUnsafeMutableBytes { raw in
            let context = CGContext(data: raw.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return bytes
    }

    /// Behind a transcript, every ink keeps its ratio over the worst pixel of every print of every
    /// still, light and dark.
    @Test(arguments: schemes)
    func everyRunReadsOverTheTranscriptsWorstPixel(scheme: ColorScheme) throws {
        let inks = Backdrop.Inks(scheme)
        try Self.theStillsAskSomething(inks, scheme)
        for (name, still) in Self.stills() {
            for treatment in Self.treatments {
                let image = try #require(Backdrop.transcriptImage(still, treatment: treatment, dark: scheme == .dark, inks: inks, size: CGSize(width: 120, height: 200)))
                let pixels = Self.bytes(try #require(image.cgImage))
                for (run, ink, need) in Self.needs(inks, scheme) {
                    let worst = Self.worst(ink, over: pixels)
                    #expect(worst >= need, "\(run) over \(name), \(treatment), \(scheme): \(worst) under \(need)")
                }
            }
        }
    }

    /// The faces resolve to their own inks, and the body does not read over the bright still on the dark face
    /// or the dark still on the light face when drawn as they are, so a pass means the guard did the work.
    static func theStillsAskSomething(_ inks: Backdrop.Inks, _ scheme: ColorScheme) throws {
        #expect((scheme == .dark) == (inks.ground.luminance < 0.2), "\(scheme) resolved the other face's ground")
        let still = try #require(stills().first { $0.name == (scheme == .dark ? "white" : "black") }).image
        #expect(worst(inks.ink, over: bytes(still)) < 4.5, "the body reads over the bare \(scheme == .dark ? "white" : "black") still")
    }

    /// A bright picture keeps what colour it can: the guard lowers a pixel only as far as the words need.
    @Test func theGuardKeepsAllThePictureThatReads() {
        let inks = Backdrop.Inks(.dark)
        let range = Backdrop.readableRange(inks)
        let fits = inks.ground.mixed(toward: Backdrop.RGB(0.1, 0.15, 0.3), by: 0.5)
        #expect(range.contains(fits.luminance))
        #expect(Backdrop.hush(fits, ground: inks.ground, range: range) == fits)
        let white = Backdrop.hush(Backdrop.RGB(1, 1, 1), ground: inks.ground, range: range)
        #expect(white.luminance > inks.ground.luminance, "the picture was taken all the way to the ground")
        #expect(range.contains(white.luminance))
    }

    /// Under the empty session, the shader's print keeps every ink's ratio over its worst pixel, as the
    /// screen draws it.
    @Test(arguments: schemes)
    func everyRunReadsOverTheEmptySessionsWorstPixel(scheme: ColorScheme) throws {
        let inks = Backdrop.Inks(scheme)
        try Self.theStillsAskSomething(inks, scheme)
        let looks: [BackgroundLook] = [
            .init(id: "a", effect: .ditherColor, asIs: false, faces: .init(light: "l", dark: "d")),
            .init(id: "b", effect: .dither, asIs: false, faces: .init(light: "l", dark: "d")),
            .init(id: "c", effect: .halftone, asIs: false, faces: .init(light: "l", dark: "d")),
            .init(id: "d", effect: .dither, asIs: true, faces: .init(light: "l", dark: "d")),
        ]
        for (name, still) in Self.stills() {
            for look in looks {
                let view = BackdropView(look: look, still: UIImage(cgImage: still), empty: true, transcript: .constant(nil))
                    .frame(width: 160, height: 160)
                    .environment(\.colorScheme, scheme)
                let pixels = try Self.drawn(view, size: CGSize(width: 160, height: 160))
                if name == "ramp" && look.asIs {
                    // The capture holds the picture, not a blank or the plain ground.
                    let shades = Set(stride(from: 0, to: pixels.count, by: 4).map { pixels[$0 + 1] })
                    #expect(shades.count > 16, "\(look.id), \(scheme): the capture shows \(shades.count) shades")
                }
                for (run, ink, need) in Self.needs(inks, scheme) {
                    let worst = Self.worst(ink, over: pixels)
                    #expect(worst >= need, "\(run) over \(name), \(look.id), \(scheme): \(worst) under \(need)")
                }
            }
        }
    }

    /// The view as the screen draws it, in a window: RGBA bytes.
    static func drawn(_ view: some View, size: CGSize) throws -> [UInt8] {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: view)
        host.safeAreaRegions = []
        window.rootViewController = host
        window.frame = CGRect(origin: .zero, size: size)
        window.makeKeyAndVisible()
        host.view.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.4))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        window.isHidden = true
        return bytes(try #require(image.cgImage))
    }

    /// Increase Contrast and Reduce Transparency each keep the plain ground; Low Data Mode fetches none.
    @Test func theAccessibilitySettingsKeepThePlainGround() {
        #expect(BackdropPolicy.shows(increasedContrast: false, reduceTransparency: false))
        #expect(!BackdropPolicy.shows(increasedContrast: true, reduceTransparency: false))
        #expect(!BackdropPolicy.shows(increasedContrast: false, reduceTransparency: true))
        #expect(BackdropPolicy.mayFetch(lowData: false))
        #expect(!BackdropPolicy.mayFetch(lowData: true))
    }

    // MARK: - The store

    /// A Mac that answers with a look and a still, counting what it was asked.
    final class Mac: @unchecked Sendable {
        var looks = 0, stills = 0
        var refusal: RPCError?
        let look = BackgroundLook(id: "sky-and-cliffs", effect: .ditherColor, asIs: false, faces: .init(light: "gallery:sky-day.jpg", dark: "gallery:space-webb.jpg"))
        let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).jpegData(withCompressionQuality: 0.8) { c in
            UIColor.orange.setFill()
            c.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }

        var source: BackdropStore.Source {
            .init(look: { _ in
                self.looks += 1
                if let refusal = self.refusal { throw ChannelError.rpc(refusal) }
                return self.look
            }, still: { _ in
                self.stills += 1
                return self.jpeg
            })
        }
    }

    static func folder() -> URL {
        URL.temporaryDirectory.appending(path: "backdrops-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    /// A Mac from before backgrounds: the session keeps its plain ground, and the phone asks no more.
    @Test func aMacWithoutTheCallLeavesThePlainGround() async {
        let mac = Mac()
        mac.refusal = RPCError(code: "METHOD_NOT_FOUND", message: "no mobile.v1 call backgrounds.look")
        let store = BackdropStore(folder: Self.folder())
        await store.load("s1", dark: false, refresh: true, lowData: false, from: mac.source)
        #expect(store.macHasNone)
        #expect(store.shown("s1", dark: false) == nil)
        await store.load("s2", dark: false, refresh: true, lowData: false, from: mac.source)
        #expect(mac.looks == 1)
        #expect(mac.stills == 0)
    }

    /// Any other failure is not taken for an old Mac: the next open asks again.
    @Test func aFailedAskIsAskedAgain() async {
        let mac = Mac()
        mac.refusal = RPCError(code: "INTERNAL", message: "busy")
        let store = BackdropStore(folder: Self.folder())
        await store.load("s1", dark: false, refresh: true, lowData: false, from: mac.source)
        #expect(!store.macHasNone)
        mac.refusal = nil
        await store.load("s1", dark: false, refresh: true, lowData: false, from: mac.source)
        #expect(store.shown("s1", dark: false) != nil)
    }

    /// The first open fetches the face's still; every later one, even from a new launch, only the look.
    @Test func aStillIsFetchedOnceAndKept() async {
        let mac = Mac(), folder = Self.folder()
        let store = BackdropStore(folder: folder)
        await store.load("s1", dark: false, refresh: true, lowData: false, from: mac.source)
        #expect(store.shown("s1", dark: false)?.look == mac.look)
        #expect(mac.stills == 1)
        let relaunched = BackdropStore(folder: folder)
        await relaunched.load("s2", dark: false, refresh: true, lowData: false, from: mac.source)
        #expect(relaunched.shown("s2", dark: false) != nil)
        #expect(mac.looks == 2)
        #expect(mac.stills == 1)
    }

    /// In Low Data Mode no still is fetched, and one already on the phone is still shown.
    @Test func lowDataFetchesNoStill() async {
        let mac = Mac(), folder = Self.folder()
        let store = BackdropStore(folder: folder)
        await store.load("s1", dark: true, refresh: true, lowData: true, from: mac.source)
        #expect(mac.stills == 0)
        #expect(store.shown("s1", dark: true) == nil)
        await store.load("s1", dark: false, refresh: false, lowData: false, from: mac.source)
        let later = BackdropStore(folder: folder)
        await later.load("s1", dark: false, refresh: true, lowData: true, from: mac.source)
        #expect(later.shown("s1", dark: false) != nil)
        #expect(mac.stills == 1)
    }

    /// With pictures off on the Mac, nothing is fetched and the ground stays plain.
    @Test func picturesOffFetchNothing() async {
        let mac = Mac()
        let store = BackdropStore(folder: Self.folder())
        let off = BackdropStore.Source(look: { _ in nil }, still: mac.source.still)
        await store.load("s1", dark: false, refresh: true, lowData: false, from: off)
        #expect(store.shown("s1", dark: false) == nil)
        #expect(mac.stills == 0)
    }
}
