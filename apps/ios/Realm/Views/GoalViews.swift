import RealmKit
import SwiftUI

extension GoalStatus {
    /// Amber only while blocked, the one stop that needs the person; every other state stays quiet.
    var tone: Tone { self == .blocked ? .waiting : .quiet }

    var symbol: String {
        switch self {
        case .blocked: "exclamationmark.triangle.fill"
        case .paused, .budgetLimited: "pause.circle"
        case .complete: "checkmark.circle"
        default: "target"
        }
    }
}

/// The objective the session is pursuing, in one line over the composer, as the desktop pins its goal
/// strip above the prompter: where it stands, what it is, and its turns and cost. Pressed, it opens
/// the whole goal and its controls.
struct GoalPill: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var sheetShown = false

    var body: some View {
        if let goal = model.store.transcript(sessionId).goal {
            Button { sheetShown = true } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: goal.status.symbol)
                        .foregroundStyle(goal.status.tone.agentColor)
                    Text(goal.status.label)
                        .fontWeight(.semibold)
                        .foregroundStyle(goal.status.tone.agentColor)
                    Text(goal.objective)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let facts = goal.facts {
                        Text(facts)
                            .monospacedDigit()
                            .foregroundStyle(Palette.ink3)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                .font(.footnote)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Fill.card, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Goal, \(goal.status.label): \(goal.objective)\(goal.facts.map { ", \($0)" } ?? "")")
            .accessibilityHint("Shows the goal and its controls")
            .accessibilityIdentifier("goal-pill")
            .sheet(isPresented: $sheetShown) {
                GoalSheet(sessionId: sessionId)
            }
        }
    }
}

/// The whole goal: its objective in the person's words, where it stands and why it stopped, when it
/// started and last changed, and the desktop strip's controls — mark done, pause or resume, drop — with
/// a new objective set as a new `/goal`.
private struct GoalSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var busy: GoalAction?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let goal = model.store.transcript(sessionId).goal {
                    VStack(alignment: .leading, spacing: 16) {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(goal.status.label, systemImage: goal.status.symbol)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(goal.status.tone.agentColor)
                                .accessibilityIdentifier("goal-status")
                            Text(goal.objective)
                                .font(.body)
                                .foregroundStyle(Palette.ink)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            if let note = goal.note, goal.status != .active {
                                Text(note)
                                    .font(.subheadline)
                                    .foregroundStyle(Palette.ink2)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .padding(Radius.cardPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .surface()
                        GoalHistory(goal: goal)
                        GoalControls(goal: goal, busy: busy, act: act, edit: {
                            model.editGoal(in: sessionId)
                            dismiss()
                        })
                    }
                    .padding(16)
                }
            }
            .background(Ground.grouped)
            .navigationTitle("Goal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Ground.grouped)
        .onChange(of: model.store.transcript(sessionId).goal == nil) { _, gone in
            if gone { dismiss() }
        }
    }

    private func act(_ action: GoalAction) {
        busy = action
        Task {
            await model.controlGoal(action, in: sessionId)
            busy = nil
        }
    }
}

/// Where the goal has got to: when it started, its turns and tokens, and when it last changed.
private struct GoalHistory: View {
    let goal: Goal

    var body: some View {
        VStack(spacing: 0) {
            line("Started", Date(timeIntervalSince1970: goal.startedAt / 1000).formatted(date: .abbreviated, time: .shortened))
            Divider().overlay(Palette.divider)
            line("Turns", "\(goal.turns)")
            Divider().overlay(Palette.divider)
            line("Tokens", goal.tokenBudget.map { "\(goal.tokensUsed.formatted()) of \($0.formatted())" } ?? goal.tokensUsed.formatted())
            Divider().overlay(Palette.divider)
            line("Last changed", Ago.text(goal.updatedAt, now: Date()))
        }
        .padding(.horizontal, Radius.cardPadding)
        .surface()
    }

    private func line(_ name: String, _ value: String) -> some View {
        HStack {
            Text(name).foregroundStyle(Palette.ink2)
            Spacer()
            Text(value).foregroundStyle(Palette.ink).monospacedDigit()
        }
        .font(.subheadline)
        .padding(.vertical, 11)
        .accessibilityElement(children: .combine)
    }
}

/// The desktop strip's controls, as many as the goal's state allows: Mark done while unfinished, Pause
/// while it runs, Resume once stopped; Change goal and Drop always.
private struct GoalControls: View {
    let goal: Goal
    let busy: GoalAction?
    let act: (GoalAction) -> Void
    let edit: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            if goal.status == .active {
                control(.pause, "Pause", "pause.fill")
            }
            if goal.status.isResumable {
                control(.resume, "Resume", "play.fill")
            }
            if goal.status.isUnfinished {
                control(.done, "Mark done", "checkmark")
            }
            Button(action: edit) {
                Label("Change goal", systemImage: "pencil").frame(maxWidth: .infinity)
            }
            .buttonStyle(GreyButtonStyle())
            .accessibilityIdentifier("goal-edit")
            // Drops the objective, never the work: what the agent did stays in the transcript.
            Button(role: .destructive) { act(.drop) } label: {
                Label("Drop goal", systemImage: "xmark").frame(maxWidth: .infinity)
            }
            .buttonStyle(GreyButtonStyle())
            .disabled(busy != nil)
            .accessibilityIdentifier("goal-drop")
        }
    }

    private func control(_ action: GoalAction, _ title: String, _ symbol: String) -> some View {
        Button { act(action) } label: {
            HStack(spacing: 6) {
                if busy == action { ProgressView().controlSize(.small) } else { Image(systemName: symbol) }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(GreyButtonStyle())
        .disabled(busy != nil)
        .accessibilityIdentifier("goal-\(action.rawValue)")
    }
}

/// The agent's to-do list over the composer, as the desktop pins its plan above the prompter: done
/// over total and the item under way, folded; opened, every item in the agent's order with its state.
/// Quiet throughout, with a spinner only on the item being worked on.
struct TodoStrip: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var open: Bool

    init(sessionId: String, open: Bool = false) {
        self.sessionId = sessionId
        _open = State(initialValue: open)
    }

    var body: some View {
        let todos = model.store.transcript(sessionId).todos
        if !todos.isEmpty {
            let progress = TodoProgress(todos)
            VStack(alignment: .leading, spacing: 0) {
                Button { open.toggle() } label: {
                    HStack(alignment: .center, spacing: 8) {
                        Image(systemName: progress.allDone ? "checkmark.circle" : "checklist")
                            .foregroundStyle(Palette.ink2)
                        Text(progress.count)
                            .fontWeight(.semibold)
                            .monospacedDigit()
                            .foregroundStyle(Palette.ink2)
                        Text(progress.activeWords ?? (progress.allDone ? "Plan complete" : "Plan"))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.up")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Palette.ink3)
                            .rotationEffect(.degrees(open ? 0 : 180))
                    }
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Plan, \(progress.done) of \(progress.total) done\(progress.activeWords.map { ", \($0)" } ?? "")")
                .accessibilityValue(open ? "Open" : "Closed")
                .accessibilityIdentifier("todo-strip")
                ProgressTrack(done: progress.done, total: progress.total)
                    .padding(.horizontal, 14)
                    .padding(.bottom, open ? 4 : 9)
                if open {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(todos.enumerated()), id: \.offset) { _, item in
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
            .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.composer, style: .continuous))
            .animation(Motion.animation(reduceMotion), value: open)
        }
    }
}

/// Done over total, as a hairline that fills: readable without reading, folded or open.
private struct ProgressTrack: View {
    let done: Int
    let total: Int

    var body: some View {
        GeometryReader { proxy in
            Capsule().fill(Palette.line)
                .overlay(alignment: .leading) {
                    Capsule().fill(Palette.ink3)
                        .frame(width: total > 0 ? proxy.size.width * CGFloat(done) / CGFloat(total) : 0)
                }
        }
        .frame(height: 3)
        .accessibilityHidden(true)
    }
}

/// One item of the plan: a spinner on the one under way, a check on a finished one (its words dimmed),
/// an empty ring on one to come.
private struct TodoLine: View {
    let item: TodoItem

    var body: some View {
        // A spinner has no baseline of its own, and would sit below the words on theirs.
        HStack(alignment: .center, spacing: 10) {
            Group {
                switch item.status {
                case .inProgress: ProgressView().controlSize(.mini)
                case .completed: Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.ink3)
                case .pending: Image(systemName: "circle").foregroundStyle(Palette.ink3)
                }
            }
            .frame(width: 16)
            Text(item.content)
                .foregroundStyle(item.status == .completed ? Palette.ink3 : item.status == .inProgress ? Palette.ink : Palette.ink2)
                .strikethrough(item.status == .completed, color: Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.footnote)
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.content), \(Self.spokenState(item.status))")
    }

    static func spokenState(_ state: TodoItem.State) -> String {
        switch state {
        case .pending: "to do"
        case .inProgress: "in progress"
        case .completed: "done"
        }
    }
}

/// A turn the goal sent itself, in the transcript as the desktop draws it: one quiet line that says
/// Realm wrote it, never a bubble the person would believe they typed. A tap shows the prompt.
struct GoalTurnLine: View {
    let text: String
    let prompt: String?
    @State private var showsPrompt = false

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 5) {
                Image(systemName: "target")
                Text(text)
                if prompt != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .rotationEffect(.degrees(showsPrompt ? 90 : 0))
                }
            }
            .font(.footnote)
            .foregroundStyle(Palette.ink2)
            .frame(maxWidth: .infinity)
            if showsPrompt, let prompt {
                Text(prompt)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Fill.bubble, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if prompt != nil { withAnimation(.easeOut(duration: 0.2)) { showsPrompt.toggle() } }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(prompt != nil ? .isButton : [])
        .accessibilityHint(prompt != nil ? (showsPrompt ? "Hides what Realm sent" : "Shows what Realm sent") : "")
        .accessibilityIdentifier("goal-turn")
    }
}

/// A listed session's goal, after what its row says of the session: the target and the goal's word,
/// amber only while blocked. Only an unfinished goal is named; a finished one is history.
struct RowGoal: View {
    let goal: GoalMark
    /// After the line's other words; on a line of its own at the accessibility sizes.
    let dotted: Bool

    var body: some View {
        HStack(spacing: 6) {
            if dotted { Text("·").foregroundStyle(Palette.ink2) }
            HStack(spacing: 3) {
                Image(systemName: goal.status == .blocked ? GoalStatus.blocked.symbol : "target")
                    .font(.caption)
                Text(goal.status.label)
            }
            .foregroundStyle(goal.status.tone.agentColor)
        }
        .font(.footnote)
        .fixedSize()
        .layoutPriority(3)
        .accessibilityHidden(true)
    }
}
