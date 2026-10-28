import RealmKit
import SwiftUI
import UIKit

/// Who answers, at the head of each reply, as Manus names itself over its own: the agent's mark and
/// name, and the model it runs on, on a badge.
struct SpeakerLabel: View {
    let session: SessionRow

    var body: some View {
        HStack(spacing: 8) {
            AgentMark(kind: session.agent, mark: session.agentMark, colored: true, size: 18, relativeTo: .headline)
            Text(session.agentDisplayName)
                .font(.headline)
                .foregroundStyle(Palette.ink)
            if let model = session.modelDisplayName, !model.isEmpty {
                Text(model)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.accentInk)
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Palette.accentTint, in: Capsule())
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// What the session is doing now, as its current step's card says it.
struct CurrentStep: Equatable {
    let words: String

    /// From the transcript, while a turn runs: its newest step, as Manus's card names the step under
    /// way — the tool running, in the present tense; thinking; else the turn's last tool, done. The
    /// words being written are the transcript's to say, so the card never repeats them. Nil once the
    /// turn is over.
    static func of(_ transcript: Transcript) -> CurrentStep? {
        guard transcript.isLive, (transcript.status ?? transcript.session?.status) == .running else { return nil }
        if case .thinking = transcript.rows.last?.content { return CurrentStep(words: "Thinking") }
        let turn = transcript.rows.reversed().prefix { if case .user = $0.content { false } else { true } }
        guard let step = turn.first(where: { if case .tool = $0.content { true } else { false } }),
              case .tool(let name, let summary, let state, _) = step.content else {
            return CurrentStep(words: "Working")
        }
        let line = ToolWords.line(tool: name, summary: summary, running: state == .running)
        let object = line.object.map { ToolWords.shown($0, kind: ToolWords.kind(name)) }
        return CurrentStep(words: [line.verb, object].compactMap { $0 }.joined(separator: " "))
    }

    /// How long the turn has run, as Manus's card counts it: "00:16", "12:03", "1:02:03".
    static func clock(_ interval: TimeInterval) -> String {
        let total = max(0, Int(interval))
        let (hours, minutes, seconds) = (total / 3600, total / 60 % 60, total % 60)
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, seconds) : String(format: "%02d:%02d", minutes, seconds)
    }
}

/// The card over the composer, as Manus keeps one: what the session is doing now and for how long,
/// beside a small live picture of the simulator or machine its space has open. Pressed, it opens the
/// screens. It is there while a turn runs, and while the space has a screen to show.
struct CurrentStepCard: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var thumbnail: UIImage?
    @State private var screensShown = false

    /// The picture's longer side: the smallest the Mac makes, which is plenty for a thumbnail.
    static let thumbnailSide = 320
    /// Between one thumbnail's arrival and asking for the next.
    static let interval: Duration = .seconds(5)

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let step = CurrentStep.of(transcript)
        let screens = model.sessionScreens[sessionId] ?? []
        let live = screens.first(where: \.live)
        if step != nil || !screens.isEmpty {
            Button {
                screensShown = true
            } label: {
                HStack(spacing: 12) {
                    tile(step: step, screens: screens, live: live)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(step?.words ?? live?.name ?? screens.first?.name ?? "")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        second(step: step, screens: screens, live: live)
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(10)
                .frame(minHeight: 56)
                .contentShape(RoundedRectangle(cornerRadius: Radius.card - 4, style: .continuous))
            }
            .buttonStyle(StepCardPress())
            .disabled(screens.isEmpty)
            .accessibilityElement(children: .combine)
            .accessibilityHint(screens.isEmpty ? "" : ScreenWords.hint(screens))
            .accessibilityIdentifier("current-step")
            .task(id: Watch(screen: live, connected: model.isConnected, active: scenePhase == .active)) {
                await watch(live)
            }
            .sheet(isPresented: $screensShown) {
                ScreensSheet(sessionId: sessionId)
            }
            .transition(.opacity)
        }
    }

    /// The thumbnail of the live screen, or the glyph of what there is: the turn's work while it has no
    /// picture, the screen's kind once the turn is over. The tile takes the picture's way up — a phone
    /// stands, a Mac's window lies down — so neither is cropped to a sliver.
    @ViewBuilder
    private func tile(step: CurrentStep?, screens: [SessionScreen], live: SessionScreen?) -> some View {
        let picture = live == nil ? nil : thumbnail
        let size = Self.tileSize(picture?.size)
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Fill.well)
            if let picture {
                Image(uiImage: picture)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size.width, height: size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .transition(.opacity)
            } else if step != nil {
                Image(systemName: "progress.indicator")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.accentInk)
                    .restingPulse(when: true)
            } else {
                Image(systemName: ScreenWords.glyph(screens))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink2)
            }
        }
        .frame(width: size.width, height: size.height)
        .accessibilityHidden(true)
    }

    /// A standing tile for a standing picture, a lying one otherwise and before any picture.
    static func tileSize(_ picture: CGSize?) -> CGSize {
        guard let picture, picture.height > picture.width else { return CGSize(width: 52, height: 38) }
        return CGSize(width: 30, height: 46)
    }

    /// The card's second line: the turn's clock while it runs — only from a start this phone saw — and
    /// otherwise where the screen stands.
    @ViewBuilder
    private func second(step: CurrentStep?, screens: [SessionScreen], live: SessionScreen?) -> some View {
        if step != nil, let since = model.workingSince[sessionId] {
            TimelineView(.periodic(from: since, by: 1)) { context in
                Text(CurrentStep.clock(context.date.timeIntervalSince(since)))
                    .monospacedDigit()
                    .accessibilityLabel(PillWords.elapsed(context.date.timeIntervalSince(since), spoken: true))
            }
        } else if step != nil {
            Text(live.map { "\($0.name) · Live" } ?? "Working")
        } else if let live {
            Text(["Live", live.detail].compactMap { $0 }.joined(separator: " · "))
        } else if let first = screens.first {
            Text("Not running")
                .accessibilityLabel("\(first.name) isn't running")
        }
    }

    private struct Watch: Equatable {
        let screen: SessionScreen?
        let connected: Bool
        let active: Bool
    }

    /// A small picture of the live screen now and then, for as long as the card shows one and the app
    /// is in front.
    private func watch(_ screen: SessionScreen?) async {
        guard let screen, model.isConnected, scenePhase == .active else { return }
        while !Task.isCancelled {
            do {
                let frame = try await model.screenFrame(screen, in: sessionId, maxSide: Self.thumbnailSide)
                if let image = UIImage(data: frame.data) { thumbnail = image }
                try await Task.sleep(for: Self.interval)
            } catch is CancellationError {
                return
            } catch {
                if ScreenWords.isGone(error) { return }
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }
}

/// The current step's card: Manus's white card with its soft lift, a step deeper while pressed.
private struct StepCardPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Palette.hover : Fill.card,
                        in: RoundedRectangle(cornerRadius: Radius.card - 4, style: .continuous))
            .floatingLift()
    }
}
