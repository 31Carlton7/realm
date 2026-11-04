import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit
import WebKit

/// A TeX expression or a Mermaid diagram, drawn.
final class BlockDrawing: Sendable {
    /// Nil when it did not draw; `reason` says why for a diagram.
    let image: UIImage?
    /// How far an expression hangs below its baseline, in points.
    let depth: CGFloat
    let reason: String?
    /// The diagram's own title, or what Mermaid says it drew, as a reader names it: "Sequence diagram".
    let name: String?

    init(image: UIImage?, depth: CGFloat = 0, reason: String? = nil, name: String? = nil) {
        self.image = image
        self.depth = depth
        self.reason = reason
        self.name = name
    }
}

/// Where TeX and diagrams are drawn: KaTeX and Mermaid, bundled (Blocks/vendor), in one web view kept
/// behind the app's own views and photographed, so the transcript scrolls pictures rather than live
/// web views. It loads nothing but the bundled page — a content rule blocks every other address — and
/// draws one block at a time, keeping each drawing by what it was drawn from, so a message scrolled
/// back to or redrawn by a streamed delta costs nothing.
///
/// TeX is drawn white on black and kept as a mask, tinted in the view, so one drawing serves both
/// faces. A diagram is drawn on the block's ground in the face on screen, so each face is drawn once.
@MainActor
final class BlockDrawer: NSObject, WKNavigationDelegate {
    static let shared = BlockDrawer()

    private let cache: NSCache<NSString, BlockDrawing> = {
        let cache = NSCache<NSString, BlockDrawing>()
        cache.totalCostLimit = 48 << 20
        return cache
    }()
    private var webView: WKWebView?
    private var loaded: CheckedContinuation<Void, Never>?
    private var page: Task<WKWebView?, Never>?
    /// The draw in progress: the next one waits for it.
    private var last: Task<Void, Never>?
    private let images = CIContext()

    func cached(_ key: String) -> BlockDrawing? {
        cache.object(forKey: key as NSString)
    }

    /// TeX at `size` points, as a mask with its depth.
    func math(_ tex: String, display: Bool, size: CGFloat) async -> BlockDrawing {
        let key = Self.mathKey(tex, display: display, size: size)
        return await draw(key) { webView in
            let answer = try await webView.callAsyncJavaScript("return await realmBlocks.math(tex, display, px)",
                                                                arguments: ["tex": tex, "display": display, "px": Double(size)], contentWorld: .page)
            guard let frame = Self.frame(answer), let shot = await self.snapshot(webView, frame), let mask = self.mask(shot) else {
                return BlockDrawing(image: nil)
            }
            let depth = (answer as? [String: Any])?["depth"] as? Double ?? 0
            return BlockDrawing(image: mask, depth: depth)
        }
    }

    /// A diagram on the block's ground in one face.
    func diagram(_ source: String, colors: DiagramColors) async -> BlockDrawing {
        await draw(Self.diagramKey(source, colors: colors)) { webView in
            let answer = try await webView.callAsyncJavaScript("return await realmBlocks.diagram(source, tokens)",
                                                                arguments: ["source": source, "tokens": colors.tokens], contentWorld: .page)
            let fields = answer as? [String: Any] ?? [:]
            guard let frame = Self.frame(answer) else {
                return BlockDrawing(image: nil, reason: fields["reason"] as? String ?? "Mermaid could not draw it")
            }
            guard let shot = await self.snapshot(webView, frame) else { return BlockDrawing(image: nil, reason: "the drawing could not be kept") }
            return BlockDrawing(image: shot, name: fields["title"] as? String ?? Self.diagramName(fields["type"] as? String ?? ""))
        }
    }

    static func mathKey(_ tex: String, display: Bool, size: CGFloat) -> String {
        "math \(display) \(Int(size * 2))\n\(tex)"
    }

    static func diagramKey(_ source: String, colors: DiagramColors) -> String {
        "diagram \(colors.key)\n\(source)"
    }

    private func draw(_ key: String, _ work: @escaping @MainActor (WKWebView) async throws -> BlockDrawing) async -> BlockDrawing {
        if let done = cached(key) { return done }
        let previous = last
        let job = Task { () -> BlockDrawing in
            await previous?.value
            if let done = cached(key) { return done }
            // A row scrolled past before its turn is not drawn for nobody.
            if Task.isCancelled { return BlockDrawing(image: nil) }
            guard let webView = await pageReady() else { return BlockDrawing(image: nil, reason: "the diagram drawer did not load") }
            let drawing = (try? await work(webView)) ?? BlockDrawing(image: nil, reason: "Mermaid could not draw it")
            let cost = drawing.image.map { Int($0.size.width * $0.size.height * $0.scale * $0.scale * 4) } ?? 64
            cache.setObject(drawing, forKey: key as NSString, cost: cost)
            return drawing
        }
        last = Task { _ = await job.value }
        return await withTaskCancellationHandler { await job.value } onCancel: { job.cancel() }
    }

    private func pageReady() async -> WKWebView? {
        if let page { return await page.value }
        let task = Task { await self.load() }
        page = task
        return await task.value
    }

    private func load() async -> WKWebView? {
        guard let folder = Bundle.main.url(forResource: "Blocks", withExtension: nil),
              let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first else { return nil }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block"}},{"trigger":{"url-filter":"^file:"},"action":{"type":"ignore-previous-rules"}}]"#
        if let list = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "realm-blocks", encodedContentRuleList: rules) {
            configuration.userContentController.add(list)
        }
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1200, height: 1600), configuration: configuration)
        webView.isOpaque = true
        webView.backgroundColor = .black
        webView.isUserInteractionEnabled = false
        // In the window it would take the safe area as an inset, and every drawing would sit that far
        // below where the page says it is.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.accessibilityElementsHidden = true
        webView.navigationDelegate = self
        // Behind every view the app draws: WebKit only paints a web view that is in a window.
        window.insertSubview(webView, at: 0)
        await withCheckedContinuation { continuation in
            loaded = continuation
            webView.loadFileURL(folder.appendingPathComponent("blocks.html"), allowingReadAccessTo: folder)
        }
        self.webView = webView
        return webView
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded?.resume()
        loaded = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loaded?.resume()
        loaded = nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        action.request.url?.isFileURL == true ? .allow : .cancel
    }

    private static func frame(_ answer: Any?) -> CGRect? {
        guard let fields = answer as? [String: Any], fields["ok"] as? Bool == true,
              let x = fields["x"] as? Double, let y = fields["y"] as? Double,
              let width = fields["width"] as? Double, let height = fields["height"] as? Double, width > 0, height > 0 else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func snapshot(_ webView: WKWebView, _ frame: CGRect) async -> UIImage? {
        let needed = CGSize(width: max(webView.frame.width, frame.maxX), height: max(webView.frame.height, frame.maxY))
        if needed != webView.frame.size { webView.frame.size = needed }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = frame
        configuration.afterScreenUpdates = true
        return try? await webView.takeSnapshot(configuration: configuration)
    }

    /// White ink on black, as the ink alone: the white's coverage becomes the alpha of a template.
    private func mask(_ image: UIImage) -> UIImage? {
        guard let cgImage = image.cgImage else { return nil }
        let filter = CIFilter.maskToAlpha()
        filter.inputImage = CIImage(cgImage: cgImage)
        guard let output = filter.outputImage, let masked = images.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: masked, scale: image.scale, orientation: .up).withRenderingMode(.alwaysTemplate)
    }

    private static let names: [String: String] = [
        "flowchart": "Flowchart", "flowchart-v2": "Flowchart", "graph": "Flowchart", "sequence": "Sequence diagram",
        "classDiagram": "Class diagram", "class": "Class diagram", "stateDiagram": "State diagram", "state": "State diagram",
        "er": "Entity relationship diagram",
    ]

    static func diagramName(_ type: String) -> String {
        names[type] ?? names[type.replacingOccurrences(of: #"-v\d+$"#, with: "", options: .regularExpression)] ?? "Diagram"
    }
}

/// Realm's tokens resolved for a diagram in one face, each laid over the block's ground the way the
/// screen composites it — Mermaid derives its shades from hex and nothing else (block-theme.ts).
struct DiagramColors: Equatable {
    let tokens: [String: Any]
    let key: String

    init(dark: Bool, ground: Color) {
        let traits = UITraitCollection(userInterfaceStyle: dark ? .dark : .light)
        func rgba(_ name: String) -> (CGFloat, CGFloat, CGFloat, CGFloat) {
            (UIColor(named: name) ?? .gray).resolvedColor(with: traits).rgba
        }
        let base = UIColor(ground).resolvedColor(with: traits).rgba
        func over(_ name: String, _ under: (CGFloat, CGFloat, CGFloat, CGFloat)) -> (CGFloat, CGFloat, CGFloat, CGFloat) {
            let top = rgba(name)
            let a = top.3
            return (top.0 * a + under.0 * (1 - a), top.1 * a + under.1 * (1 - a), top.2 * a + under.2 * (1 - a), 1)
        }
        func hex(_ c: (CGFloat, CGFloat, CGFloat, CGFloat)) -> String {
            let byte = { (v: CGFloat) in Int((min(max(v, 0), 1) * 255).rounded()) }
            return String(format: "#%02x%02x%02x", byte(c.0), byte(c.1), byte(c.2))
        }
        // A node is one step off the ground, as the hover rung is on each face.
        let node = over("Hover", base)
        let tokens: [String: Any] = [
            "dark": dark,
            "ground": hex(base),
            "ink": hex(over("Ink", base)),
            "ink2": hex(over("Ink2", base)),
            "ink3": hex(over("Ink3", base)),
            "node": hex(node),
            "raised": hex(over("Hover2", base)),
            "edge": hex(over("LineStrong", node)),
            "quiet": hex(over("Line", base)),
            "well": hex(over("Inset", base)),
            "series": (1...8).map { hex(over("Series\($0)", base)) },
        ]
        self.tokens = tokens
        key = ["ground", "ink", "ink2", "ink3", "node", "raised", "edge", "quiet", "well"].compactMap { tokens[$0] as? String }.joined(separator: " ")
    }

    static func == (lhs: DiagramColors, rhs: DiagramColors) -> Bool { lhs.key == rhs.key }
}

private extension UIColor {
    var rgba: (CGFloat, CGFloat, CGFloat, CGFloat) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return (r, g, b, a)
    }
}
