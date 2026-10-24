import RealmKit
import SwiftUI

/// Where a sub-agent stands, as its lead's Agents tab says it on the Mac: what its session is doing
/// now, and once it is not busy, how its run ended — a finished one someone has sent a message to is
/// working again, whatever its outcome says. A glyph and a word in its tone, never colour alone.
enum SubagentState: Equatable {
    case working, waiting, done, failed, timedOut, stopped, cancelled
    /// An ending this phone has no word of its own for, in the Mac's.
    case other(String)

    init(_ subagent: Subagent) {
        switch subagent.session.status {
        case .running:
            self = .working
        case .waiting:
            self = .waiting
        default:
            if let outcome = subagent.outcome {
                self = Self.ended(outcome)
            } else if subagent.session.status == .error {
                self = .failed
            } else if subagent.settledAt == nil {
                // Its run is under way, and has not begun its first turn.
                self = .working
            } else if subagent.report != nil {
                // A tool that keeps no record of how its run ended: its last word is the evidence it finished.
                self = .done
            } else {
                self = subagent.session.status == .ended ? .failed : .stopped
            }
        }
    }

    /// The Mac's word for how a run ended: the delegation's own, or its Agents tab's.
    private static func ended(_ outcome: String) -> SubagentState {
        switch outcome.lowercased() {
        case "done": .done
        case "failed", "gone": .failed
        case "timeout", "timed out": .timedOut
        case "stopped": .stopped
        case "interrupted", "cancelled": .cancelled
        default: .other(outcome)
        }
    }

    var word: String {
        switch self {
        case .working: "Working"
        case .waiting: "Needs you"
        case .done: "Done"
        case .failed: "Failed"
        case .timedOut: "Timed out"
        case .stopped: "Stopped"
        case .cancelled: "Cancelled"
        case .other(let word): word.prefix(1).uppercased() + word.dropFirst()
        }
    }

    var symbol: String {
        switch self {
        case .working: "progress.indicator"
        case .waiting: "hand.raised.fill"
        case .done: "checkmark.circle.fill"
        case .failed, .timedOut: "exclamationmark.circle.fill"
        case .stopped, .cancelled: "stop.circle.fill"
        case .other: "circle.fill"
        }
    }

    var tone: Tone {
        switch self {
        case .working: .working
        case .waiting: .waiting
        case .done: .done
        case .failed, .timedOut: .failed
        case .stopped, .cancelled, .other: .quiet
        }
    }

    /// Still going: its clock runs, and the bar's control wears the working mark.
    var isLive: Bool { self == .working || self == .waiting }
}

/// A session's sub-agents, newest first, as the Mac lists them; two started at the same moment keep
/// the Mac's order.
enum SubagentOrder {
    static func newestFirst(_ subagents: [Subagent]) -> [Subagent] {
        subagents.stablySorted { $0.startedAt > $1.startedAt }
    }
}

/// What the session bar's control says: how many sub-agents, and whether one is still going.
struct SubagentsControlLabel: Equatable {
    let words: String
    let working: Bool

    /// Nil for a session that has started none: its bar shows nothing for them.
    init?(_ subagents: [Subagent]) {
        guard !subagents.isEmpty else { return nil }
        words = SubagentWords.count(subagents.count)
        working = subagents.contains { SubagentState($0).isLive }
    }
}

/// What the sub-agents' control and sheet say.
enum SubagentWords {
    /// "1 sub-agent", "2 sub-agents"
    static func count(_ count: Int) -> String {
        count == 1 ? "1 sub-agent" : "\(count) sub-agents"
    }

    /// Where they all stand, the ones that need the person first: "1 needs you · 2 working · 1 done";
    /// spoken with pauses between, where the dots are only for the eye.
    static func rollup(_ states: [SubagentState], separator: String = " · ") -> String {
        var counts = [0, 0, 0, 0, 0]
        for state in states { counts[group(state)] += 1 }
        let words = [counts[0] == 1 ? "needs you" : "need you", "working", "done", "failed", "stopped"]
        return zip(counts, words).filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }.joined(separator: separator)
    }

    /// Which of the rollup's words a state counts under, in the order they are said.
    private static func group(_ state: SubagentState) -> Int {
        switch state {
        case .waiting: 0
        case .working: 1
        case .done: 2
        case .failed, .timedOut: 3
        case .stopped, .cancelled, .other: 4
        }
    }

    /// What it was asked to do, as its lead's Agents tab titles it: its session's name for the task,
    /// else the first line of its goal — the rest of a goal is the brief it was handed, which its own
    /// session shows. A name an older Mac wrote as "Agent: " and the goal's first words, cut short, is
    /// passed over for the goal's line, which says the same whole.
    static func title(_ subagent: Subagent) -> String {
        let name = subagent.session.title.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty, !name.hasPrefix("Agent: "), !name.hasPrefix("Browser agent: ") { return name }
        let line = (subagent.goal ?? "").split(separator: "\n").lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
        return line ?? "Sub-agent"
    }

    /// How long it ran, or has run so far, in seconds.
    static func ran(_ subagent: Subagent, state: SubagentState, now: Date) -> TimeInterval {
        let end = state.isLive ? now.timeIntervalSince1970 * 1000 : (subagent.settledAt ?? subagent.session.updatedAt)
        return max(0, end - subagent.startedAt) / 1000
    }

    /// Its report as a few lines of plain prose: a row is not a document, so headings, fences and
    /// emphasis are dropped rather than drawn — an underscore only at a word's edge, where it marks
    /// emphasis, since inside one it is part of a name. The whole report is its session's, a press away.
    static func report(_ subagent: Subagent) -> String? {
        guard let report = subagent.report else { return nil }
        let plain = report
            .replacing(/```[\s\S]*?(```|$)/, with: " ")
            .replacing(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/.anchorsMatchLineEndings(), with: "")
            .replacing(/\[([^\]]*)\]\([^)]*\)/) { String($0.output.1) }
            .replacing(/[*`~]+/, with: "")
            .replacing(/(^|[^\p{L}\p{N}])_+/) { String($0.output.1) }
            .replacing(/_+([^\p{L}\p{N}]|$)/) { String($0.output.1) }
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return plain.isEmpty ? nil : plain
    }

    /// A row as VoiceOver reads it: what it was asked, where it stands and for how long, its model, its
    /// report.
    static func spoken(_ subagent: Subagent, now: Date) -> String {
        let state = SubagentState(subagent)
        let model = subagent.session.modelDisplayName ?? subagent.session.agentDisplayName
        let ran = PillWords.elapsed(Self.ran(subagent, state: state, now: now), spoken: true)
        return [title(subagent), state.word, ran, model, subagent.note, report(subagent)].compactMap { $0 }.joined(separator: ", ")
    }
}

/// The session's sub-agents, as a chip over the composer — the one place that says who is working
/// (design.md ▸ Agent sessions), never a count in the session's bar: how many, with the working mark
/// while one runs. It opens their sheet; a session that has started none shows nothing for them.
struct SubagentsChip: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @State private var shown = false

    var body: some View {
        let subagents = model.work.subagents[sessionId] ?? []
        if let label = SubagentsControlLabel(subagents) {
            Button {
                shown = true
            } label: {
                HStack(spacing: 6) {
                    if label.working {
                        Image(systemName: "progress.indicator")
                            .foregroundStyle(Palette.accentInk)
                            .restingPulse(when: true)
                    } else {
                        Image(systemName: "person.2")
                    }
                    Text(label.words)
                }
                .font(.subheadline.weight(.medium))
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.capsule)
            .accessibilityLabel(label.words)
            .accessibilityValue(SubagentWords.rollup(subagents.map(SubagentState.init), separator: ", "))
            .accessibilityHint("Lists them")
            .accessibilityIdentifier("subagents")
            .sheet(isPresented: $shown) {
                SubagentsSheet(sessionId: sessionId)
            }
        }
    }
}

/// The sub-agents a session started, newest first. Pressing one puts the sheet away and opens its own
/// session over the lead's, the way back leading to the lead.
private struct SubagentsSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let subagents = model.work.subagents[sessionId] ?? []
        NavigationStack {
            List {
                ForEach(subagents) { subagent in
                    Button {
                        dismiss()
                        model.path.append(.session(subagent.id))
                    } label: {
                        SubagentRow(subagent: subagent)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Fill.card)
                    .accessibilityIdentifier("subagent-\(subagent.id)")
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
            .navigationTitle("Sub-agents")
            .navigationSubtitle(SubagentWords.rollup(subagents.map(SubagentState.init)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // A close, not "Done": the rows under it say Done of the runs that finished.
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityLabel("Close")
                }
            }
        }
        // At the accessibility sizes half the screen holds less than a row.
        .presentationDetents(dynamicTypeSize.isAccessibilitySize ? [.large] : [.medium, .large])
        .presentationBackground(Ground.grouped)
        .task { await model.work.loadSubagents(sessionId) }
    }
}

/// One sub-agent: its goal, then its model, where it stands and for how long, then its report folded
/// to a few lines — or why Realm stopped it, where it did.
private struct SubagentRow: View {
    let subagent: Subagent
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 20

    var body: some View {
        let state = SubagentState(subagent)
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: state.symbol)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(state.tone.color)
                .restingPulse(when: state == .working)
                .frame(width: glyph)
            VStack(alignment: .leading, spacing: 5) {
                Text(SubagentWords.title(subagent))
                    .font(.body)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
                facts(state)
                if let note = subagent.note {
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(3)
                }
                if let report = SubagentWords.report(subagent) {
                    Text(report)
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.ink3)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SubagentWords.spoken(subagent, now: Date()))
        .accessibilityHint("Opens its session")
    }

    /// The model, the state's word in its tone, and how long it ran — on one line with dots between, or
    /// each on a line of its own at the accessibility sizes. A run still going counts up.
    private func facts(_ state: SubagentState) -> some View {
        let stacked = dynamicTypeSize.isAccessibilitySize
        let line = stacked
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 6))
        return line {
            HStack(spacing: 4) {
                AgentMark(kind: subagent.session.agent, mark: subagent.session.agentMark, size: 12, relativeTo: .footnote)
                Text(subagent.session.modelDisplayName ?? subagent.session.agentDisplayName)
                    .lineLimit(1)
            }
            .foregroundStyle(Palette.ink2)
            if !stacked { dot }
            Text(state.word)
                .fontWeight(.semibold)
                .foregroundStyle(state.tone.color)
                .fixedSize()
            if !stacked { dot }
            if state.isLive {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    ran(state, now: context.date)
                }
            } else {
                ran(state, now: Date())
            }
        }
        .font(.footnote)
    }

    private var dot: some View {
        Text("·").foregroundStyle(Palette.ink2)
    }

    private func ran(_ state: SubagentState, now: Date) -> some View {
        Text(PillWords.elapsed(SubagentWords.ran(subagent, state: state, now: now)))
            .monospacedDigit()
            .foregroundStyle(Palette.ink2)
            .fixedSize()
    }
}
