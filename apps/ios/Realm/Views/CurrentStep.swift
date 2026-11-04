import RealmKit
import SwiftUI
import UIKit

/// Who answers, at the head of each reply, as Manus names itself over its own: the agent's mark and
/// name, and the model it runs on in the quiet ink after it.
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
                    .font(.subheadline)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(1)
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

/// The one dock over the composer, as Manus keeps one card there: what the session is doing now and
/// for how long, and under it, quieter, the goal it works toward and how far the agent's plan has got.
/// Each part opens its own thing — the step the screens, the goal its sheet, the plan its items, in
/// place. Idle, it is only the goal and the plan; with neither, and no screen, it is not there.
struct WorkDock: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var thumbnail: UIImage?
    @State private var screensShown = false
    @State private var goalShown = false
    @State private var planOpen: Bool

    init(sessionId: String, planOpen: Bool = false) {
        self.sessionId = sessionId
        _planOpen = State(initialValue: planOpen)
    }

    /// The picture's longer side: the smallest the Mac makes, which is plenty for a thumbnail.
    static let thumbnailSide = 320
    /// Between one thumbnail's arrival and asking for the next.
    static let interval: Duration = .seconds(5)

    var body: some View {
        let transcript = model.store.transcript(sessionId)
        let step = CurrentStep.of(transcript)
        let screens = model.sessionScreens[sessionId] ?? []
        let live = screens.first(where: \.live)
        let goal = transcript.goal
        let plan = transcript.todos.isEmpty ? nil : TodoProgress(transcript.todos)
        let now = step != nil || !screens.isEmpty
        if now || goal != nil || plan != nil {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    if now { tile(step: step, screens: screens, live: live) }
                    VStack(alignment: .leading, spacing: 3) {
                        if now { headline(step: step, plan: plan, screens: screens, live: live) }
                        if goal != nil || plan != nil { context(goal: goal, plan: plan, alone: !now) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                if planOpen, let plan {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(plan.items.enumerated()), id: \.offset) { _, item in
                                TodoLine(item: item)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.bottom, 8)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(maxHeight: 240)
                    .fixedSize(horizontal: false, vertical: true)
                    .transition(.opacity)
                }
            }
            .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.card - 4, style: .continuous))
            .floatingLift()
            .animation(Motion.animation(reduceMotion), value: planOpen)
            .task(id: Watch(screen: live, connected: model.isConnected, active: scenePhase == .active)) {
                await watch(live)
            }
            .transition(.opacity)
        }
    }

    /// The first line: the plan's item under way, else the step the turn is on, and the turn's clock —
    /// or, between turns, the screen the space has open and where it stands. Pressed, it opens the
    /// screens; with none, the plan; with neither, it is only words.
    @ViewBuilder
    private func headline(step: CurrentStep?, plan: TodoProgress?, screens: [SessionScreen], live: SessionScreen?) -> some View {
        let words = step.map { plan?.activeWords ?? $0.words } ?? live?.name ?? screens.first?.name ?? ""
        let line = HStack(spacing: 0) {
            Text(words)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .truncationMode(plan?.activeWords == nil ? .middle : .tail)
            second(step: step, screens: screens, live: live)
                .fontWeight(.regular)
                .foregroundStyle(Palette.ink2)
                .lineLimit(1)
                .fixedSize()
        }
        .font(.subheadline.weight(.medium))
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        Group {
            if !screens.isEmpty || plan != nil {
                Button {
                    if !screens.isEmpty { screensShown = true } else { planOpen.toggle() }
                } label: { line }
                .buttonStyle(.plain)
            } else {
                line
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(screens.isEmpty ? "" : ScreenWords.hint(screens))
        .accessibilityIdentifier("current-step")
        .sheet(isPresented: $screensShown) {
            ScreensSheet(sessionId: sessionId)
        }
    }

    /// After the first line's words: the turn's clock while it runs — only from a start this phone saw —
    /// and otherwise where the screen stands.
    @ViewBuilder
    private func second(step: CurrentStep?, screens: [SessionScreen], live: SessionScreen?) -> some View {
        if step != nil, let since = model.workingSince[sessionId] {
            TimelineView(.periodic(from: since, by: 1)) { context in
                Text(" · \(CurrentStep.clock(context.date.timeIntervalSince(since)))")
                    .monospacedDigit()
                    .accessibilityLabel(PillWords.elapsed(context.date.timeIntervalSince(since), spoken: true))
            }
        } else if step != nil {
            if live != nil { Text(" · Live") }
        } else if let live {
            Text(([" · Live"] + [live.detail].compactMap { $0 }).joined(separator: " · "))
        } else if let first = screens.first {
            Text(" · Not running")
                .accessibilityLabel("\(first.name) isn't running")
        }
    }

    /// The line under it, in the quieter words: the goal, then the plan's count over its hairline. Alone,
    /// between turns, it is the dock's only line, and takes the first line's size.
    private func context(goal: Goal?, plan: TodoProgress?, alone: Bool) -> some View {
        HStack(spacing: 8) {
            if let goal {
                Button { goalShown = true } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Image(systemName: goal.status.symbol)
                            .foregroundStyle(goal.status.tone.agentColor)
                        // Pursuing goes without saying while the turn's spinner says it.
                        if goal.status != .active || alone {
                            Text(goal.status.label)
                                .fontWeight(.semibold)
                                .foregroundStyle(goal.status.tone.agentColor)
                                .fixedSize()
                        }
                        Text(goal.objective)
                            .foregroundStyle(alone ? Palette.ink : Palette.ink2)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if plan == nil, let facts = goal.facts {
                            Text(facts)
                                .monospacedDigit()
                                .foregroundStyle(Palette.ink3)
                                .lineLimit(1)
                                .fixedSize()
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Goal, \(goal.status.label): \(goal.objective)\(goal.facts.map { ", \($0)" } ?? "")")
                .accessibilityHint("Shows the goal and its controls")
                .accessibilityIdentifier("goal-pill")
                .sheet(isPresented: $goalShown) {
                    GoalSheet(sessionId: sessionId)
                }
            }
            if let plan {
                Button { planOpen.toggle() } label: {
                    HStack(spacing: 6) {
                        if goal == nil {
                            Image(systemName: plan.allDone ? "checkmark.circle" : "checklist")
                        }
                        Text(plan.count)
                            .monospacedDigit()
                        ProgressTrack(done: plan.done, total: plan.total)
                            .frame(width: 36)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Palette.ink3)
                            .rotationEffect(.degrees(planOpen ? 180 : 0))
                    }
                    .foregroundStyle(Palette.ink2)
                    .fixedSize()
                    .frame(maxWidth: goal == nil ? .infinity : nil, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Plan, \(plan.done) of \(plan.total) done\(plan.activeWords.map { ", \($0)" } ?? "")")
                .accessibilityValue(planOpen ? "Open" : "Closed")
                .accessibilityIdentifier("todo-strip")
            }
        }
        .font(alone ? .subheadline : .footnote)
    }

    /// The thumbnail of the live screen, or the mark of what there is: the turn's spinner while it has
    /// no picture, the screen's kind once the turn is over. The tile takes the picture's way up — a phone
    /// stands, a Mac's window lies down — so neither is cropped to a sliver.
    @ViewBuilder
    private func tile(step: CurrentStep?, screens: [SessionScreen], live: SessionScreen?) -> some View {
        if live != nil, let thumbnail {
            let size = Self.tileSize(thumbnail.size)
            Image(uiImage: thumbnail)
                .resizable()
                .scaledToFill()
                .frame(width: size.width, height: size.height)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .transition(.opacity)
                .accessibilityHidden(true)
        } else {
            Image(systemName: step != nil ? "progress.indicator" : ScreenWords.glyph(screens))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(step != nil ? Tone.working.agentColor : Palette.ink2)
                .restingPulse(when: step != nil)
                .frame(width: 20)
                .accessibilityHidden(true)
        }
    }

    /// A standing tile for a standing picture, a lying one otherwise.
    static func tileSize(_ picture: CGSize) -> CGSize {
        picture.height > picture.width ? CGSize(width: 30, height: 46) : CGSize(width: 52, height: 38)
    }

    private struct Watch: Equatable {
        let screen: SessionScreen?
        let connected: Bool
        let active: Bool
    }

    /// A small picture of the live screen now and then, for as long as the dock shows one and the app
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
