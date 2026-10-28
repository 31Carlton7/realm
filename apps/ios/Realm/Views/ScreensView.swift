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

/// A screen the session's space has open, watched from the phone as Manus shows its computer: the
/// picture on a card headed with the screen's name, asked of the Mac about once a second while the
/// sheet is up; what the agent is doing under it; and Pause, which holds the picture still and stops
/// asking, beside Share. With more than one screen, a menu at the bar's trailing edge picks which.
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
        let shown = picture.flatMap { $0.screenId == screen?.id ? $0 : nil }
        let transcript = model.store.transcript(sessionId)
        NavigationStack {
            VStack(spacing: 16) {
                ScreenStage(screen: screen, picture: shown, trouble: trouble, resting: resting == screen?.id)
                if let step = CurrentStep.of(transcript), let session = transcript.session {
                    AgentAtWork(session: session, step: step)
                }
                ScreenStatus(screen: screen, picture: shown, paused: paused, trouble: trouble)
                if let screen, screen.live {
                    HStack(spacing: 12) {
                        Button {
                            paused.toggle()
                        } label: {
                            Label(paused ? "Jump to live" : "Pause", systemImage: paused ? "play.fill" : "pause.fill")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Palette.ink)
                                .padding(.horizontal, 20)
                                .frame(minHeight: 44)
                                .background(Fill.card, in: Capsule())
                                .floatingLift()
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint(paused ? "Asks your Mac for the picture again" : "Holds the picture still")
                        if let shown {
                            ShareLink(item: Image(uiImage: shown.image), preview: SharePreview(screen.name, image: Image(uiImage: shown.image))) {
                                Image(systemName: "square.and.arrow.up")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(Palette.ink)
                                    .frame(width: 44, height: 44)
                                    .background(Fill.card, in: Circle())
                                    .floatingLift()
                            }
                            .accessibilityLabel("Share")
                        }
                    }
                    .padding(.bottom, 8)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Ground.grouped)
            .navigationTitle(screens.count > 1 ? "Screens" : screen?.name ?? "Screens")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                if screens.count > 1, let screen {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Picker("Screen", selection: Binding(get: { screen.id }, set: { selected = $0 })) {
                                ForEach(screens) { screen in
                                    Label(screen.name, systemImage: ScreenWords.glyph(screen.kind)).tag(screen.id)
                                }
                            }
                        } label: {
                            Label(screen.name, systemImage: ScreenWords.glyph(screen.kind))
                        }
                        .accessibilityLabel("Screen, \(screen.name)")
                        .accessibilityIdentifier("screen-picker")
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
        VStack(spacing: 0) {
            // The card's head names what is on it, as Manus heads its computer with the file it shows.
            if let screen {
                HStack(spacing: 6) {
                    Image(systemName: ScreenWords.glyph(screen.kind))
                    Text([screen.name, screen.detail].compactMap { $0 }.joined(separator: " · "))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .font(.footnote)
                .foregroundStyle(Palette.ink2)
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity, minHeight: 40)
                .accessibilityElement(children: .combine)
                Rectangle()
                    .fill(Palette.line)
                    .frame(height: 1)
                    .accessibilityHidden(true)
            }
            picturePlace
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .surface(Fill.card)
        .animation(.easeOut(duration: 0.2), value: picture == nil)
    }

    private var picturePlace: some View {
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
    }
}

/// Under the picture, while a turn runs, what the agent is doing, as Manus says it is using a tool:
/// the agent's mark on a tile, the agent at work, and the step in its words.
private struct AgentAtWork: View {
    let session: SessionRow
    let step: CurrentStep

    var body: some View {
        HStack(spacing: 12) {
            AgentMark(kind: session.agent, mark: session.agentMark, colored: true, size: 18, relativeTo: .body)
                .frame(width: 38, height: 38)
                .background(Fill.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("\(session.agentDisplayName) is working")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink)
                Text(step.words)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
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
