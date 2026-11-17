import CoreImage
import RealmKit
import SwiftUI
import UIKit

/// The picture behind a session, as the desktop prints it (design.md, "The looks are data"): a still
/// printed through a dither in the face's tones, the colour-kept dither, halftone dots, or as it is.
/// Under the empty session the print is a shader over the still. Behind a transcript it is worked out
/// once into a small, softly blurred image, never a material over moving words. Either way each pixel
/// is taken toward the ground only as far as the transcript's inks need to keep reading over it.
enum Backdrop {
    /// A colour as sRGB, 0 to 1.
    struct RGB: Equatable {
        var r: Double, g: Double, b: Double

        init(_ r: Double, _ g: Double, _ b: Double) {
            self.r = r
            self.g = g
            self.b = b
        }

        init(_ color: Color, in scheme: ColorScheme) {
            let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            UIColor(color).resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
            self.init(Double(r), Double(g), Double(b))
        }

        func mixed(toward other: RGB, by t: Double) -> RGB {
            RGB(r + (other.r - r) * t, g + (other.g - g) * t, b + (other.b - b) * t)
        }

        /// WCAG relative luminance.
        var luminance: Double {
            func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
        }

        /// The print's own brightness, from the encoded values, as the desktop's shader reads it.
        var luma: Double { 0.2126 * r + 0.7152 * g + 0.0722 * b }

        func contrast(with other: RGB) -> Double {
            let (a, b) = (luminance, other.luminance)
            return (max(a, b) + 0.05) / (min(a, b) + 0.05)
        }
    }

    /// The ground a session stands on, and the inks its words are drawn in over the picture: the body,
    /// the quiet ink, and the link.
    struct Inks: Equatable {
        let ground: RGB, ink: RGB, ink2: RGB, link: RGB, accent: RGB
        /// The ratio the link keeps: 3:1 on the light face (design.md), 4.5:1 on the dark.
        let linkRatio: Double

        init(ground: RGB, ink: RGB, ink2: RGB, link: RGB, accent: RGB, linkRatio: Double) {
            self.ground = ground
            self.ink = ink
            self.ink2 = ink2
            self.link = link
            self.accent = accent
            self.linkRatio = linkRatio
        }

        init(_ scheme: ColorScheme) {
            self.init(ground: RGB(Ground.transcript, in: scheme), ink: RGB(Palette.ink, in: scheme), ink2: RGB(Palette.ink2, in: scheme),
                      link: RGB(Palette.accentInk, in: scheme), accent: RGB(Palette.accent, in: scheme), linkRatio: scheme == .light ? 3 : 4.5)
        }
    }

    /// What the guard keeps in hand over each ratio, as the desktop's does, for the 8-bit rounding of
    /// the image and of the print over it.
    static let spare = 0.3

    /// The luminances a pixel may have so that every ink keeps its ratio over it: 4.5:1 for the body and
    /// the quiet ink, the link's own for the link, and never more than that ink has on the plain ground.
    static func readableRange(_ inks: Inks) -> ClosedRange<Double> {
        let ground = inks.ground.luminance
        var lo = 0.0, hi = 1.0
        for (ink, ratio) in [(inks.ink, 4.5), (inks.ink2, 4.5), (inks.link, inks.linkRatio)] {
            let plain = ink.contrast(with: inks.ground)
            let floor = min(ratio + spare, plain) - 0.005
            let l = ink.luminance
            if l > ground { hi = min(hi, (l + 0.05) / floor - 0.05) } else { lo = max(lo, floor * (l + 0.05) - 0.05) }
        }
        return min(lo, ground)...max(hi, ground)
    }

    /// `pixel` taken toward the ground only as far as its luminance must go to be inside `range`.
    static func hush(_ pixel: RGB, ground: RGB, range: ClosedRange<Double>) -> RGB {
        if range.contains(pixel.luminance) { return pixel }
        var keep = 0.0, miss = 1.0
        for _ in 0..<10 {
            let t = (keep + miss) / 2
            if range.contains(ground.mixed(toward: pixel, by: t).luminance) { keep = t } else { miss = t }
        }
        return ground.mixed(toward: pixel, by: keep)
    }

    // MARK: - The prints

    /// How one face prints a still through the two-tone dither or the halftone: the desktop's `LOOKS`.
    struct Face {
        let lo: Double, hi: Double, invert: Bool, gamma: Double, inkAmount: Double, tint: Double, photo: Double, photoGain: Double
    }

    struct Print {
        /// Points per cell; 0 is one device pixel.
        let cell: Double
        let halftone: Bool
        let highlight: Double
        let light: Face, dark: Face
    }

    static let dither = Print(cell: 0, halftone: false, highlight: 0,
        light: Face(lo: 0.08, hi: 0.95, invert: true, gamma: 1.1, inkAmount: 0.22, tint: 0.6, photo: 0.75, photoGain: 1),
        dark: Face(lo: 0.05, hi: 0.8, invert: false, gamma: 1.3, inkAmount: 0.2, tint: 0.5, photo: 0.6, photoGain: 0.3))
    static let halftone = Print(cell: 6, halftone: true, highlight: 0.2,
        light: Face(lo: 0.02, hi: 0.8, invert: false, gamma: 1.2, inkAmount: 0.26, tint: 0, photo: 0, photoGain: 1),
        dark: Face(lo: 0.02, hi: 0.85, invert: false, gamma: 1.2, inkAmount: 0.3, tint: 0, photo: 0, photoGain: 1))
    /// The colour-kept dither: how much darker a screened cell is than its colour.
    static let colorDepth = 0.22

    /// How a look's picture is drawn on one face.
    enum Treatment: Equatable {
        case asIs, colorKept, printed(halftone: Bool)

        init(_ look: BackgroundLook) {
            if look.asIs { self = .asIs; return }
            switch look.effect {
            case .ditherColor: self = .colorKept
            case .dither: self = .printed(halftone: false)
            case .halftone: self = .printed(halftone: true)
            }
        }
    }

    private static func smoothstep(_ e0: Double, _ e1: Double, _ v: Double) -> Double {
        let t = min(1, max(0, (v - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    }

    /// What a pixel of `color` averages to once printed, which is what a blur of the print shows: the
    /// share of cells inked, as the shader decides it, spread over the cell.
    static func printedMean(_ color: RGB, _ treatment: Treatment, dark: Bool, inks: Inks) -> RGB {
        switch treatment {
        case .asIs:
            return color
        case .colorKept:
            let cover = 0.04 + 0.6 * pow(1 - color.luma, 1.4)
            let k = 1 - colorDepth * cover
            return RGB(color.r * k, color.g * k, color.b * k)
        case .printed(let isHalftone):
            let print = isHalftone ? halftone : dither
            let face = dark ? print.dark : print.light
            let lit = pow(color.luma, face.gamma)
            let l = face.invert ? 1 - lit : lit
            let cover = face.lo + (face.hi - face.lo) * l
            let grey = color.luma
            let chroma = RGB((color.r - grey) * face.tint, (color.g - grey) * face.tint, (color.b - grey) * face.tint)
            let photo = RGB(color.r * face.photoGain, color.g * face.photoGain, color.b * face.photoGain)
            let base = inks.ground.mixed(toward: photo, by: face.photo)
            let ground = RGB(base.r + chroma.r, base.g + chroma.g, base.b + chroma.b)
            var ink = ground.mixed(toward: inks.ink, by: face.inkAmount)
            if print.highlight > 0 {
                ink = ink.mixed(toward: inks.ground.mixed(toward: inks.accent, by: face.inkAmount * 1.6), by: print.highlight * smoothstep(0.7, 0.95, lit))
            }
            // A round dot's share of its cell: its radius is 0.62 √cover of the cell's side.
            let share = isHalftone ? min(1, Double.pi * 0.3844 * cover) : cover
            return ground.mixed(toward: ink, by: share)
        }
    }

    // MARK: - Behind a transcript

    /// Points to one pixel of the transcript's picture: it is blurred well past that, so a finer image
    /// would hold no more, only more pixels to hush.
    static let transcriptScale: CGFloat = 2
    /// The blur, in points: the edge blur's deeper radius, as the desktop's `--fade-blur-far`.
    static let transcriptBlur: CGFloat = 6

    /// The picture behind a transcript `size` points large: the still cover-fit from its top, printed,
    /// blurred, and every pixel hushed for the inks. Nil for a still that will not decode.
    static func transcriptImage(_ still: CGImage, treatment: Treatment, dark: Bool, inks: Inks, size: CGSize) -> UIImage? {
        let width = max(1, Int((size.width / transcriptScale).rounded(.up)))
        let height = max(1, Int((size.height / transcriptScale).rounded(.up)))
        guard var pixels = cover(still, width: width, height: height) else { return nil }
        for i in stride(from: 0, to: pixels.count, by: 4) {
            let mean = printedMean(RGB(Double(pixels[i]) / 255, Double(pixels[i + 1]) / 255, Double(pixels[i + 2]) / 255), treatment, dark: dark, inks: inks)
            pixels[i] = byte(mean.r)
            pixels[i + 1] = byte(mean.g)
            pixels[i + 2] = byte(mean.b)
        }
        guard var blurred = blur(pixels, width: width, height: height, radius: transcriptBlur / transcriptScale) else { return nil }
        let range = readableRange(inks)
        for i in stride(from: 0, to: blurred.count, by: 4) {
            let p = hush(RGB(Double(blurred[i]) / 255, Double(blurred[i + 1]) / 255, Double(blurred[i + 2]) / 255), ground: inks.ground, range: range)
            blurred[i] = byte(p.r)
            blurred[i + 1] = byte(p.g)
            blurred[i + 2] = byte(p.b)
            blurred[i + 3] = 255
        }
        guard let image = cgImage(blurred, width: width, height: height) else { return nil }
        return UIImage(cgImage: image, scale: 1 / transcriptScale, orientation: .up)
    }

    /// Rounds down, so that a hushed value never rounds up past the range it was brought into.
    private static func byte(_ v: Double) -> UInt8 { UInt8(max(0, min(255, (v * 255).rounded(.down)))) }

    private static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

    /// The still drawn to cover `width`×`height` pixels from its top, as RGBA bytes.
    static func cover(_ still: CGImage, width: Int, height: Int) -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: sRGB, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            let scale = max(CGFloat(width) / CGFloat(still.width), CGFloat(height) / CGFloat(still.height))
            let w = CGFloat(still.width) * scale, h = CGFloat(still.height) * scale
            context.interpolationQuality = .high
            // Core Graphics counts up from the bottom: the still's top meets the image's top.
            context.draw(still, in: CGRect(x: (CGFloat(width) - w) / 2, y: CGFloat(height) - h, width: w, height: h))
            return true
        }
        return drawn ? bytes : nil
    }

    private static func cgImage(_ bytes: [UInt8], width: Int, height: Int) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: sRGB,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil,
                       shouldInterpolate: true, intent: .defaultIntent)
    }

    private static let context = CIContext(options: [.workingColorSpace: sRGB, .outputColorSpace: sRGB])

    /// A Gaussian blur of `radius` pixels, its edges clamped so that the picture runs to the image's edge.
    private static func blur(_ bytes: [UInt8], width: Int, height: Int, radius: CGFloat) -> [UInt8]? {
        guard let source = cgImage(bytes, width: width, height: height) else { return nil }
        let image = CIImage(cgImage: source).clampedToExtent().applyingGaussianBlur(sigma: radius).cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
        var out = [UInt8](repeating: 0, count: width * height * 4)
        out.withUnsafeMutableBytes { raw in
            context.render(image, toBitmap: raw.baseAddress!, rowBytes: width * 4, bounds: image.extent, format: .RGBA8, colorSpace: sRGB)
        }
        return out
    }
}

/// When a session wears its picture, and when the phone asks the Mac for one.
enum BackdropPolicy {
    /// Under Increase Contrast or Reduce Transparency the session keeps its plain ground.
    static func shows(increasedContrast: Bool, reduceTransparency: Bool) -> Bool {
        !increasedContrast && !reduceTransparency
    }

    /// In Low Data Mode no still is fetched; one the phone holds already is still shown.
    static func mayFetch(lowData: Bool) -> Bool {
        !lowData
    }
}

/// The picture behind a session: printed by the shader under the empty session, and the blurred,
/// hushed still behind a transcript, which `transcript` holds for the edges to fade into. It fills the
/// screen to its bottom edge and is never a material.
struct BackdropView: View {
    let look: BackgroundLook
    let still: UIImage
    let empty: Bool
    @Binding var transcript: BackdropPicture?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let inks = Backdrop.Inks(scheme)
            // A ZStack, not a Group: until the transcript's picture is made there is nothing else in
            // it, and a Group with nothing in it never runs the task that makes the picture.
            ZStack {
                Color.clear
                if empty {
                    printed(size: size, inks: inks)
                } else if let transcript, transcript.key == key(size) {
                    Image(uiImage: transcript.image)
                        .resizable()
                        .interpolation(.medium)
                        .frame(width: size.width, height: size.height)
                }
            }
            .task(id: empty ? nil : key(size)) {
                guard !empty, size.width > 0, let cg = still.cgImage else { return }
                let treatment = Backdrop.Treatment(look), dark = scheme == .dark, key = key(size)
                let image = await Task.detached(priority: .userInitiated) {
                    Backdrop.transcriptImage(cg, treatment: treatment, dark: dark, inks: inks, size: size)
                }.value
                if let image { transcript = BackdropPicture(key: key, image: image, size: size) }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func key(_ size: CGSize) -> String { "\(look.id)|\(scheme)|\(Int(size.width))x\(Int(size.height))" }

    private func printed(size: CGSize, inks: Backdrop.Inks) -> some View {
        let range = Backdrop.readableRange(inks)
        let treatment = Backdrop.Treatment(look)
        let print = treatment == .printed(halftone: true) ? Backdrop.halftone : Backdrop.dither
        let face = scheme == .dark ? print.dark : print.light
        let mode: Float = switch treatment {
        case .printed(let halftone): halftone ? 1 : 0
        case .colorKept: 2
        case .asIs: 3
        }
        let cell = print.cell > 0 ? Float((print.cell * displayScale).rounded()) : 1
        let rgb = { (c: Backdrop.RGB) -> [Float] in [Float(c.r), Float(c.g), Float(c.b)] }
        let shader = ShaderLibrary.realmPrint(
            .float(Float(displayScale)), .float(mode), .float(cell),
            .floatArray(rgb(inks.ground) + rgb(inks.ink) + rgb(inks.accent)),
            .floatArray([Float(face.lo), Float(face.hi), face.invert ? 1 : 0, Float(face.gamma), Float(face.inkAmount), Float(face.tint),
                         Float(face.photo), Float(face.photoGain), Float(print.highlight), Float(Backdrop.colorDepth)]),
            .float2(Float(range.lowerBound), Float(range.upperBound)))
        return Image(uiImage: still)
            .resizable()
            .aspectRatio(contentMode: .fill)
            .frame(width: size.width, height: size.height, alignment: .top)
            .clipped()
            .layerEffect(shader, maxSampleOffset: CGSize(width: 8, height: 8))
    }
}
