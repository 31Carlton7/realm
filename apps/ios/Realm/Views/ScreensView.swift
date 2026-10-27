import RealmKit
import SwiftUI
import UIKit

/// How the phone talks about the screens a session's space has open on the Mac.
enum ScreenWords {
    /// A screen's glyph: a phone for a simulator, a display for a machine.
    static func glyph(_ kind: SessionScreen.Kind) -> String {
        kind == .simulator ? "iphone" : "display"
    }

    /// The bar button's glyph: the one kind the space has open, or both.
    static func glyph(_ screens: [SessionScreen]) -> String {
        let kinds = Set(screens.map(\.kind))
        return kinds.count == 1 ? glyph(kinds.first!) : "rectangle.on.rectangle"
    }

    /// What VoiceOver hears the bar button opens: "Shows iPhone 17 Pro", "Shows 2 screens".
    static func hint(_ screens: [SessionScreen]) -> String {
        screens.count == 1 ? "Shows \(screens[0].name)" : "Shows \(screens.count) screens"
    }

    /// Why a picture did not come: the Mac's own words where it said why.
    static func trouble(_ error: Error) -> String {
        switch error {
        case ChannelError.rpc(let rpc) where !rpc.message.isEmpty: rpc.message
        case ChannelError.notConnected, ChannelError.macOffline, ChannelError.connectionLost: "Your Mac isn't connected"
        case ChannelError.timedOut: "The picture took too long to arrive"
        default: "The picture didn't arrive"
        }
    }

    /// The Mac says the screen is not running (`FORBIDDEN`) or not there at all (`NOT_FOUND`): asking
    /// again every second will not change that, so the watch stops until the list says otherwise.
    static func isGone(_ error: Error) -> Bool {
        if case ChannelError.rpc(let rpc) = error { return rpc.code == "FORBIDDEN" || rpc.code == "NOT_FOUND" }
        return false
    }

    /// How old the picture on screen is: "Just now", "12s ago", "3m ago".
    static func age(_ interval: TimeInterval) -> String {
        interval < 3 ? "Just now" : "\(PillWords.elapsed(interval)) ago"
    }
}

/// The bar's Screens button: what the session's space has open on the Mac — a simulator, a machine —
/// to watch from here. The bar draws it only once the Mac has said there is one.
struct ScreensButton: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var shown = false

    var body: some View {
        let screens = model.sessionScreens[sessionId] ?? []
        Button {
            shown = true
        } label: {
            Label("Screens", systemImage: ScreenWords.glyph(screens))
        }
        .accessibilityHint(ScreenWords.hint(screens))
        .accessibilityIdentifier("screens")
        .sheet(isPresented: $shown) {
            ScreensSheet(sessionId: sessionId)
        }
    }
}

/// A screen the session's space has open, watched from the phone: its picture, asked of the Mac about
/// once a second while the sheet is up, as Manus shows its computer. Pause holds the picture still and
/// stops asking; with more than one screen, a control along the top picks which.
struct ScreensSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selected: String?
    @State private var paused = false
    @State private var picture: ScreenPicture?
    @State private var trouble: String?
    /// The screen the Mac says is gone or not running: the watch rests until the list changes.
    @State private var resting: String?

    /// The picture's longer side, in pixels: sharp on the phone, and small enough to ask for every second.
    static let maxSide = 1000
    /// Between one picture's arrival and asking for the next.
    static let interval: Duration = .seconds(1)

    struct ScreenPicture: Equatable {
        let screenId: String
        let image: UIImage
        let at: Date
    }

    var body: some View {
        let screens = model.sessionScreens[sessionId] ?? []
        let screen = screens.first { $0.id == selected } ?? screens.first
        NavigationStack {
            VStack(spacing: 14) {
                if screens.count > 1 {
                    Picker("Screen", selection: Binding(get: { screen?.id }, set: { selected = $0 })) {
                        ForEach(screens) { screen in
                            Label(screen.name, systemImage: ScreenWords.glyph(screen.kind)).tag(Optional(screen.id))
                        }
                    }
                    .pickerStyle(.segmented)
                }
                ScreenStage(screen: screen, picture: picture.flatMap { $0.screenId == screen?.id ? $0 : nil },
                            trouble: trouble, resting: resting == screen?.id)
                ScreenStatus(screen: screen, picture: picture.flatMap { $0.screenId == screen?.id ? $0 : nil },
                             paused: paused, trouble: trouble)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Ground.grouped)
            .navigationTitle(screen?.name ?? "Screens")
            .navigationSubtitle(screen?.detail ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                if let screen, screen.live {
                    ToolbarItemGroup(placement: .bottomBar) {
                        Spacer()
                        Button {
                            paused.toggle()
                        } label: {
                            Label(paused ? "Resume" : "Pause", systemImage: paused ? "play.fill" : "pause.fill")
                                .labelStyle(.titleAndIcon)
                        }
                        .accessibilityHint(paused ? "Asks your Mac for the picture again" : "Holds the picture still")
                        if let picture, picture.screenId == screen.id {
                            ShareLink(item: Image(uiImage: picture.image), preview: SharePreview(screen.name, image: Image(uiImage: picture.image))) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        }
                        Spacer()
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationBackground(Ground.grouped)
        .task { await model.loadScreens(sessionId) }
        .task(id: Watch(screen: screen, paused: paused, connected: model.isConnected)) {
            await watch(screen)
        }
        .onChange(of: screens) { resting = nil }
    }

    /// What the watch depends on: a change of any of it starts it again.
    private struct Watch: Equatable {
        let screen: SessionScreen?
        let paused: Bool
        let connected: Bool
    }

    /// Asks for the screen's picture, then again a moment after each arrives, for as long as the sheet
    /// shows that screen live and unpaused. A refusal that says it is gone rests the watch; anything
    /// else is said under the picture and tried again a little later.
    private func watch(_ screen: SessionScreen?) async {
        trouble = nil
        guard let screen, screen.live, !paused, resting != screen.id else { return }
        while !Task.isCancelled {
            do {
                let frame = try await model.screenFrame(screen, in: sessionId, maxSide: Self.maxSide)
                if let image = UIImage(data: frame.data) {
                    picture = ScreenPicture(screenId: screen.id, image: image, at: Date())
                    trouble = nil
                }
                try await Task.sleep(for: Self.interval)
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled else { return }
                trouble = ScreenWords.trouble(error)
                if ScreenWords.isGone(error) {
                    resting = screen.id
                    await model.loadScreens(sessionId)
                    return
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
}

/// The picture itself, laid into a rounded ground and left its own square edge, with room between the
/// two so it never reaches the corner (design.md ▸ Shape, the machine pane's screen). Before the first
/// picture, and for a screen that is not running, the ground says why it is empty.
private struct ScreenStage: View {
    let screen: SessionScreen?
    let picture: ScreensSheet.ScreenPicture?
    let trouble: String?
    let resting: Bool
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        ZStack {
            if let picture {
                Image(uiImage: picture.image)
                    .resizable()
                    .scaledToFit()
                    .overlay {
                        // A picture's edge, so a dark screen does not bleed into the ground.
                        Rectangle().strokeBorder(Palette.line, lineWidth: 1 / displayScale)
                    }
                    .padding(12)
                    .accessibilityLabel(screen.map { "\($0.name), as it is on your Mac" } ?? "Screen")
                    .transition(.opacity)
            } else if let screen, !screen.live || resting {
                ContentUnavailableView {
                    Label("\(screen.name) isn't running", systemImage: ScreenWords.glyph(screen.kind))
                } description: {
                    Text("Open it on your Mac to see it here.")
                }
            } else if screen == nil {
                ContentUnavailableView("Nothing to show", systemImage: "rectangle.on.rectangle",
                                       description: Text("This session's space has no simulator or machine open."))
            } else if let trouble {
                ContentUnavailableView(trouble, systemImage: "exclamationmark.triangle")
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .surface(Fill.card)
        .animation(.easeOut(duration: 0.2), value: picture == nil)
    }
}

/// Under the picture: whether it is live, held, or late, and how old it is when that matters.
private struct ScreenStatus: View {
    let screen: SessionScreen?
    let picture: ScreensSheet.ScreenPicture?
    let paused: Bool
    let trouble: String?
    /// The dot grows with the word beside it, as a glyph would.
    @ScaledMetric(relativeTo: .subheadline) private var dot: CGFloat = 8

    var body: some View {
        if let screen, screen.live {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let age = picture.map { context.date.timeIntervalSince($0.at) }
                let late = trouble != nil || (age ?? 0) > 5
                let (word, tone): (String, Color) = paused ? ("Paused", Palette.ink3)
                    : late ? (trouble ?? "Waiting for your Mac", Palette.orange)
                    : picture == nil ? ("Connecting…", Palette.ink3) : ("Live", Palette.green)
                HStack(spacing: 8) {
                    Circle()
                        .fill(tone)
                        .frame(width: dot, height: dot)
                        .accessibilityHidden(true)
                    Text(word)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(2)
                    Spacer(minLength: 8)
                    if let age, paused || late {
                        Text(ScreenWords.age(age))
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(Palette.ink2)
                    }
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 32)
                .accessibilityElement(children: .combine)
            }
        }
    }
}
