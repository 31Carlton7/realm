import RealmKit
import SwiftUI
import UIKit

/// How the phone talks about the browser and terminal panes a session's space has open on the Mac.
enum PaneWords {
    static let browserGlyph = "globe"
    static let terminalGlyph = "terminal"

    /// The address as a person reads it in a list: its host and path, without the scheme.
    static func address(_ url: String) -> String {
        guard let parts = URLComponents(string: url), let host = parts.host else { return url }
        let port = parts.port.map { ":\($0)" } ?? ""
        let path = parts.path == "/" ? "" : parts.path
        return host + port + path
    }

    /// A browser pane's second line: where it is, or that it is a blank tab.
    static func browserLine(_ pane: BrowserPane) -> String {
        pane.url.isEmpty ? "New tab" : address(pane.url)
    }

    /// Why there is no picture of a pane that is not live.
    static let notOpen = "Not open in a window on your Mac"

    static func terminalState(running: Bool) -> String {
        running ? "Running" : "Not running"
    }
}

/// A pane picked to watch: what `paneViewers` presents.
enum PaneOpening: Identifiable, Hashable {
    case screen(SessionScreen)
    case browser(BrowserPane)
    case terminal(TerminalPane)

    var id: String {
        switch self {
        case .screen(let pane): "screen:\(pane.id)"
        case .browser(let pane): "browser:\(pane.id)"
        case .terminal(let pane): "terminal:\(pane.id)"
        }
    }
}

extension View {
    /// Presents the pane picked in `opening`: a screen in the screens sheet, a browser or a terminal in
    /// its viewer, full screen. Set on the screen's own stack, not on a row of a list, which lets go of
    /// what it presents as the list lays itself out again.
    func paneViewers(sessionId: String, opening: Binding<PaneOpening?>) -> some View {
        let screen = Binding<SessionScreen?>(get: { if case .screen(let pane) = opening.wrappedValue { pane } else { nil } },
                                             set: { if $0 == nil { opening.wrappedValue = nil } })
        let browser = Binding<BrowserPane?>(get: { if case .browser(let pane) = opening.wrappedValue { pane } else { nil } },
                                            set: { if $0 == nil { opening.wrappedValue = nil } })
        let terminal = Binding<TerminalPane?>(get: { if case .terminal(let pane) = opening.wrappedValue { pane } else { nil } },
                                              set: { if $0 == nil { opening.wrappedValue = nil } })
        return sheet(item: screen) { pane in ScreensSheet(sessionId: sessionId, initial: pane.id) }
            .fullScreenCover(item: browser) { pane in BrowserViewer(sessionId: sessionId, pane: pane) }
            .fullScreenCover(item: terminal) { pane in TerminalViewer(sessionId: sessionId, pane: pane) }
    }
}

/// The Panes section of a session's info: the screens, browsers and terminals its space has open on
/// the Mac, as the desktop names them. Picking one sets `opening`, which `paneViewers` presents.
struct PanesSection: View {
    let sessionId: String
    @Binding var opening: PaneOpening?
    @Environment(AppModel.self) private var model

    var body: some View {
        let screens = model.sessionScreens[sessionId] ?? []
        let panes = model.sessionPanes[sessionId]
        let browsers = panes?.browsers ?? []
        let terminals = panes?.terminals ?? []
        if !screens.isEmpty || !browsers.isEmpty || !terminals.isEmpty {
            Section("Panes") {
                ForEach(screens) { item in
                    Button { opening = .screen(item) } label: {
                        PaneRow(glyph: ScreenWords.glyph(item.kind), name: item.name, line: item.detail ?? "", state: item.live ? nil : "Not running")
                    }
                }
                ForEach(browsers) { item in
                    Button { opening = .browser(item) } label: {
                        PaneRow(glyph: PaneWords.browserGlyph, favicon: item.favicon, name: item.name, line: PaneWords.browserLine(item),
                                state: item.live ? nil : "Not open")
                    }
                }
                ForEach(terminals) { item in
                    Button { opening = .terminal(item) } label: {
                        PaneRow(glyph: PaneWords.terminalGlyph, name: item.name, line: item.detail, mono: true,
                                state: item.running ? nil : PaneWords.terminalState(running: false))
                    }
                }
            }
            .buttonStyle(.plain)
            .listRowBackground(Fill.card)
        }
    }
}

/// A pane in a list: its glyph, or a page's own icon; its name; a line under it; and, when there is
/// nothing to see now, why, in the quiet ink.
struct PaneRow: View {
    let glyph: String
    var favicon: Data?
    let name: String
    let line: String
    var mono = false
    var state: String?
    @ScaledMetric(relativeTo: .body) private var icon: CGFloat = 22

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let favicon, let image = UIImage(data: favicon) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: icon * 0.8, height: icon * 0.8)
                        .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                } else {
                    Image(systemName: glyph)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(Palette.ink2)
                }
            }
            .frame(width: icon)
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !line.isEmpty {
                    Group {
                        if mono { Text(line).mono(.footnote) } else { Text(line).font(.footnote) }
                    }
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let state {
                Text(state)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink3)
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.ink3)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([name, line, state].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityHint("Opens it, to watch")
    }
}

/// The foot of a pane's viewer: that the phone only watches, and where the pane can be used.
private struct ViewOnlyNote: View {
    let state: String?
    let trouble: String?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "laptopcomputer")
                .foregroundStyle(Palette.ink2)
            VStack(alignment: .leading, spacing: 2) {
                Text("Open on your Mac to use it")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink)
                Text("This view is read only.")
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
            Spacer(minLength: 8)
            if let trouble {
                // Amber is the one status with a colour: the picture or output is late.
                Label(trouble, systemImage: "circle.fill")
                    .labelStyle(PaneStatusLabel())
                    .foregroundStyle(Palette.orange)
            } else if let state {
                Text(state)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(Fill.card)
        .accessibilityElement(children: .combine)
    }
}

private struct PaneStatusLabel: LabelStyle {
    @ScaledMetric(relativeTo: .footnote) private var dot: CGFloat = 7

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.font(.system(size: dot))
            configuration.title.font(.footnote).foregroundStyle(Palette.ink).lineLimit(2)
        }
    }
}

// MARK: - A browser pane

/// A browser pane's page, watched from the phone: a picture of it about once a second while this is up,
/// with every password field covered on the Mac before it is sent, to pinch and pan. Nothing on it can
/// be pressed: the foot says where the page can be used.
struct BrowserViewer: View {
    let sessionId: String
    let pane: BrowserPane
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var picture: UIImage?
    @State private var trouble: String?
    /// The Mac says the page is not open or gone: the watch rests.
    @State private var resting: String?

    /// Sharp on the phone, and small enough to ask for every second over cellular.
    static let maxSide = 1000
    static let interval: Duration = .seconds(1)

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack {
                    if let picture {
                        ZoomablePicture(image: picture)
                            .accessibilityLabel("\(pane.name), as it is on your Mac")
                            .accessibilityIdentifier("browser-picture")
                    } else if let resting {
                        ContentUnavailableView {
                            Label(pane.name, systemImage: PaneWords.browserGlyph)
                        } description: {
                            Text(resting)
                        }
                    } else if !pane.live {
                        ContentUnavailableView {
                            Label(pane.name, systemImage: PaneWords.browserGlyph)
                        } description: {
                            Text("\(PaneWords.notOpen). Open its pane there to see it here.")
                        }
                    } else if let trouble {
                        ContentUnavailableView(trouble, systemImage: "eye.slash")
                    } else {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Fill.well)
                ViewOnlyNote(state: picture == nil ? nil : "Live", trouble: picture == nil ? nil : trouble)
            }
            .background(Ground.grouped)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(pane.name)
                            .font(.headline)
                            .foregroundStyle(Palette.ink)
                        Text(PaneWords.browserLine(pane))
                            .font(.caption)
                            .foregroundStyle(Palette.ink2)
                    }
                    .lineLimit(1)
                    .frame(maxWidth: 240)
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityLabel("Close")
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .task(id: PaneWatch(connected: model.isConnected, active: scenePhase == .active)) {
            await watch()
        }
    }

    /// Asks for the page's picture, then again a moment after each arrives, while this is on screen and
    /// the app is in front. A refusal that says the page is gone rests the watch; anything else, the
    /// Mac's reason for no picture included, is said and tried again a little later.
    private func watch() async {
        guard pane.live, resting == nil, model.isConnected, scenePhase == .active else { return }
        while !Task.isCancelled {
            do {
                let frame = try await model.browserFrame(pane, in: sessionId, maxSide: Self.maxSide)
                if let image = UIImage(data: frame.data) {
                    picture = image
                    trouble = nil
                }
                try await Task.sleep(for: Self.interval)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                if ScreenWords.isGone(error) {
                    resting = ScreenWords.trouble(error)
                    picture = nil
                    return
                }
                trouble = ScreenWords.trouble(error)
                // A page withheld for a password field is no picture to keep showing.
                if case ChannelError.rpc = error { picture = nil }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}

/// What a viewer's watch depends on: a change of any of it starts it again.
private struct PaneWatch: Equatable {
    let connected: Bool
    let active: Bool
}

/// A picture to pinch and pan, as Photos does: fitted to begin with, up to four times as near, and a
/// double tap goes in and back. A new picture of the same page keeps the zoom it is looked at with.
private struct ZoomablePicture: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 4
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.delegate = context.coordinator
        scroll.backgroundColor = .clear
        let view = context.coordinator.imageView
        view.contentMode = .scaleAspectFit
        view.isUserInteractionEnabled = true
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.addSubview(view)
        let twice = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        twice.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(twice)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        let view = context.coordinator.imageView
        view.image = image
        if scroll.zoomScale == 1 { view.frame = scroll.bounds }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        let imageView = UIImageView()

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        @objc func doubleTapped(_ tap: UITapGestureRecognizer) {
            guard let scroll = tap.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let at = tap.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
                scroll.zoom(to: CGRect(x: at.x - size.width / 2, y: at.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}

// MARK: - A terminal

/// A terminal's output, followed from the phone: the text its pty wrote, in JetBrains Mono, coloured
/// with Realm's terminal palette, kept at its end as more arrives. Asked of the Mac about once a second
/// while this is up, each time only what came since. Nothing typed here reaches it.
struct TerminalViewer: View {
    let sessionId: String
    let pane: TerminalPane
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var text = TerminalText()
    @State private var cursor: TerminalCursor?
    @State private var running: Bool?
    @State private var trouble: String?
    @State private var gone: String?

    static let interval: Duration = .seconds(1)

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack {
                    if let gone {
                        ContentUnavailableView(gone, systemImage: PaneWords.terminalGlyph)
                    } else if cursor == nil {
                        if let trouble { ContentUnavailableView(trouble, systemImage: "exclamationmark.triangle") } else { ProgressView() }
                    } else {
                        TerminalLines(lines: text.lines)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Fill.well)
                ViewOnlyNote(state: running.map { PaneWords.terminalState(running: $0) }, trouble: cursor == nil ? nil : trouble)
            }
            .background(Ground.grouped)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(pane.name)
                            .font(.headline)
                            .foregroundStyle(Palette.ink)
                        Text(pane.detail)
                            .mono(.caption)
                            .truncationMode(.middle)
                            .foregroundStyle(Palette.ink2)
                    }
                    .lineLimit(1)
                    .frame(maxWidth: 240)
                    .accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityLabel("Close")
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .task(id: PaneWatch(connected: model.isConnected, active: scenePhase == .active)) {
            await follow()
        }
    }

    /// Reads the terminal from where the phone left it, again a moment after each answer, while this
    /// is on screen and the app is in front.
    private func follow() async {
        guard gone == nil, model.isConnected, scenePhase == .active else { return }
        while !Task.isCancelled {
            do {
                let output = try await model.terminalOutput(pane, in: sessionId, after: cursor)
                if output.reset { text.reset() }
                text.feed(output.text)
                cursor = output.cursor
                running = output.running
                trouble = nil
                try await Task.sleep(for: Self.interval)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                if ScreenWords.isGone(error) {
                    gone = ScreenWords.trouble(error)
                    return
                }
                trouble = ScreenWords.trouble(error)
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}

/// The lines themselves, kept at their end as more come, each as wide as it was printed: a terminal's
/// output scrolls sideways rather than wrapping, as code does on the Mac.
private struct TerminalLines: View {
    let lines: [TerminalLine]
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(lines) { line in
                    Text(TerminalColors.attributed(line, dark: colorScheme == .dark))
                        .mono(.caption)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .frame(minHeight: 16, alignment: .leading)
                }
            }
            .padding(12)
            .textSelection(.enabled)
        }
        .defaultScrollAnchor(.bottomLeading)
        .defaultScrollAnchor(.bottomLeading, for: .sizeChanges)
        .accessibilityIdentifier("terminal-output")
    }
}

/// Realm's sixteen terminal colours, as the Mac draws them for its own theme in each face
/// (`packages/ui/src/terminal-palette.ts`, Realm's scheme), and the rest of the 256 as xterm has them.
enum TerminalColors {
    static let dark: [UInt32] = [0x313336, 0xED7471, 0x61C380, 0xE4B65C, 0x5293E9, 0xC989D3, 0x61C6D1, 0xC9CACE,
                                 0x8F9299, 0xFD9692, 0x86DB9D, 0xF4CF7D, 0x80B8FC, 0xE1AAE9, 0x8BE2EB, 0xF9FAFB]
    static let light: [UInt32] = [0x2C2E32, 0xBC3233, 0x1D783C, 0x986106, 0x1364CE, 0x943FA2, 0x007789, 0xCFD1D5,
                                  0x696C72, 0xCD1F2A, 0x007F35, 0xA16100, 0x0065E0, 0xA03AB0, 0x007B91, 0xF6F7F9]
    /// How much of its colour faint text keeps, as the Mac mixes it.
    static func dim(dark: Bool) -> Double { dark ? 0.652 : 0.735 }

    /// A colour a program named, as RGB: the sixteen, then xterm's 6×6×6 cube and its greys, then its own.
    static func rgb(_ color: TerminalStyle.Color, dark: Bool) -> (Double, Double, Double) {
        switch color {
        case .rgb(let r, let g, let b):
            return (Double(r) / 255, Double(g) / 255, Double(b) / 255)
        case .indexed(let n) where n < 16:
            let hex = (dark ? Self.dark : Self.light)[n]
            return (Double(hex >> 16 & 0xFF) / 255, Double(hex >> 8 & 0xFF) / 255, Double(hex & 0xFF) / 255)
        case .indexed(let n) where n < 232:
            let steps: [Double] = [0, 95, 135, 175, 215, 255]
            let i = n - 16
            return (steps[i / 36] / 255, steps[i / 6 % 6] / 255, steps[i % 6] / 255)
        case .indexed(let n):
            let grey = Double(8 + (n - 232) * 10) / 255
            return (grey, grey, grey)
        }
    }

    static func color(_ color: TerminalStyle.Color, dark: Bool) -> Color {
        let (r, g, b) = rgb(color, dark: dark)
        return Color(red: r, green: g, blue: b)
    }

    /// A line as styled text: each run's colour, faintness, weight and underline. Inverse swaps the run's
    /// colours, the page's ink and ground standing in for the ones it did not name.
    static func attributed(_ line: TerminalLine, dark: Bool) -> AttributedString {
        var out = AttributedString()
        for run in line.runs {
            var piece = AttributedString(run.text)
            let style = run.style
            var foreground = style.foreground.map { color($0, dark: dark) }
            var background = style.background.map { color($0, dark: dark) }
            if style.inverse {
                (foreground, background) = (background ?? Fill.well, foreground ?? Palette.ink)
            }
            if let foreground { piece.foregroundColor = style.dim ? foreground.opacity(dim(dark: dark)) : foreground }
            else if style.dim { piece.foregroundColor = Palette.ink2 }
            if let background { piece.backgroundColor = background }
            if style.bold { piece.font = RealmType.mono(.caption, medium: true) }
            if style.underline { piece.underlineStyle = .single }
            out += piece
        }
        return out
    }
}
