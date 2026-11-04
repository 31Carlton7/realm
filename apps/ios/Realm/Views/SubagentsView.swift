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

/// Which part of their list a sub-agent stands in. The sheet lists the ones that went wrong first, then
/// the ones waiting on the person, then the ones still going, then the finished, then the ones someone
/// stopped — each newest first, as the Mac gave them.
enum SubagentGroup: CaseIterable {
    case failed, waiting, working, done, stopped

    init(_ state: SubagentState) {
        switch state {
        case .failed, .timedOut: self = .failed
        case .waiting: self = .waiting
        case .working: self = .working
        case .done: self = .done
        case .stopped, .cancelled, .other: self = .stopped
        }
    }

    /// The group's head over its rows.
    var title: String {
        switch self {
        case .failed: "Failed"
        case .waiting: "Needs you"
        case .working: "Working"
        case .done: "Done"
        case .stopped: "Stopped"
        }
    }

    /// The groups that have anyone in them, in the sheet's order, each keeping the order it was given.
    static func sections(_ subagents: [Subagent]) -> [(group: SubagentGroup, subagents: [Subagent])] {
        let grouped = Dictionary(grouping: subagents) { SubagentGroup(SubagentState($0)) }
        return allCases.compactMap { group in grouped[group].map { (group, $0) } }
    }

    /// The same order as one list, for a section that has no room for heads of its own.
    static func ordered(_ subagents: [Subagent]) -> [Subagent] {
        sections(subagents).flatMap(\.subagents)
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
        let said: [SubagentGroup] = [.waiting, .working, .done, .failed, .stopped]
        return said.compactMap { group in
            let count = states.count { SubagentGroup($0) == group }
            guard count > 0 else { return nil }
            let word = group == .waiting ? (count == 1 ? "needs you" : "need you") : group.title.lowercased()
            return "\(count) \(word)"
        }.joined(separator: separator)
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

    /// The "<handle> - " every one of them is titled with when a teammate started them all, which a
    /// list of them says once in its head rather than on every row; nil when any title lacks it.
    static func sharedPrefix(_ subagents: [Subagent]) -> String? {
        let titles = subagents.map(title)
        guard let first = titles.first, let dash = first.range(of: " - ") else { return nil }
        let prefix = String(first[..<dash.upperBound])
        guard !prefix.dropLast(3).contains(where: \.isWhitespace) else { return nil }
        return titles.allSatisfy({ $0.hasPrefix(prefix) && $0.count > prefix.count }) ? prefix : nil
    }

    /// Its title on a row of a list whose every title starts with `prefix`, which is left off.
    static func title(_ subagent: Subagent, dropping prefix: String?) -> String {
        let whole = title(subagent)
        guard let prefix, whole.hasPrefix(prefix) else { return whole }
        return String(whole.dropFirst(prefix.count))
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
                            .foregroundStyle(Tone.working.agentColor)
                            .restingPulse(when: true)
                    } else {
                        Image(systemName: "person.2")
                    }
                    Text(label.words)
                }
                .font(.subheadline.weight(.medium))
            }
            .buttonStyle(ChipButtonStyle())
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

/// The sub-agents a session started, under a head for each group of them: the failed, the ones that
/// need you, the working, the done. Pressing one puts the sheet away and opens its own session over the
/// lead's, the way back leading to the lead — opened from Home, the lead goes first.
struct SubagentsSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var expanded: Set<String> = []

    var body: some View {
        let subagents = model.work.subagents[sessionId] ?? []
        let prefix = SubagentWords.sharedPrefix(subagents)
        NavigationStack {
            List {
                ForEach(SubagentGroup.sections(subagents), id: \.group) { section in
                    Section(section.group.title) {
                        ForEach(section.subagents) { subagent in
                            SubagentRow(subagent: subagent, title: SubagentWords.title(subagent, dropping: prefix),
                                        expanded: $expanded.holds(subagent.id)) {
                                dismiss()
                                if model.path.last != .session(sessionId) { model.path.append(.session(sessionId)) }
                                model.path.append(.session(subagent.id))
                            }
                        }
                    }
                    .listRowBackground(Fill.card)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Ground.grouped)
            .softEdges(ground: Ground.grouped)
            .navigationTitle("Sub-agents")
            .navigationSubtitle(SubagentWords.rollup(subagents.map(SubagentState.init)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // A close, not "Done": the head over the finished runs says Done. At the trailing
                // corner, as every sheet whose only control is its close has it.
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .close) { dismiss() }
                        .accessibilityLabel("Close")
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        // At the accessibility sizes half the screen holds less than a row.
        .presentationDetents(dynamicTypeSize.isAccessibilitySize ? [.large] : [.medium, .large])
        .presentationBackground(Ground.grouped)
        .task { await model.work.loadSubagents(sessionId) }
    }
}

extension Binding where Value == Set<String> {
    /// Whether the set holds `member`, as a switch: on puts it in, off takes it out.
    func holds(_ member: String) -> Binding<Bool> {
        Binding<Bool> { wrappedValue.contains(member) } set: { if $0 { wrappedValue.insert(member) } else { wrappedValue.remove(member) } }
    }
}

/// One sub-agent on one line: where it stands as a mark, what it was asked, and for how long it ran.
/// Pressing it opens its session; its chevron unfolds its report in place.
struct SubagentRow: View {
    let subagent: Subagent
    let title: String
    @Binding var expanded: Bool
    let open: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 20

    var body: some View {
        let state = SubagentState(subagent)
        let report = SubagentWords.report(subagent)
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Image(systemName: state.symbol)
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(state.tone.agentColor)
                            .restingPulse(when: state == .working)
                            .frame(width: glyph)
                        Text(title)
                            .font(.body)
                            .foregroundStyle(Palette.ink)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if state.isLive {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                ran(state, now: context.date)
                            }
                        } else {
                            ran(state, now: Date())
                        }
                    }
                    if expanded {
                        detail(report)
                            .padding(.leading, glyph + 12)
                            .transition(.opacity)
                    }
                }
                .contentShape(Rectangle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(SubagentWords.spoken(subagent, now: Date()))
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens its session")
            .accessibilityIdentifier("subagent-\(subagent.id)")
            disclosure(shown: report != nil || subagent.note != nil)
        }
    }

    /// Why Realm stopped it, where it did, its report short of a page, and the model it ran on.
    private func detail(_ report: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if let note = subagent.note {
                Text(note)
            }
            if let report {
                Text(report)
                    .lineLimit(12)
            }
            HStack(spacing: 4) {
                AgentMark(kind: subagent.session.agent, mark: subagent.session.agentMark, size: 12, relativeTo: .footnote)
                Text(subagent.session.modelDisplayName ?? subagent.session.agentDisplayName)
                    .lineLimit(1)
            }
            .font(.footnote)
        }
        .font(.subheadline)
        .foregroundStyle(Palette.ink2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The chevron that opens and folds the report; a row with nothing to show keeps its room, so the
    /// times down the list stay in one column.
    private func disclosure(shown: Bool) -> some View {
        Button {
            withAnimation(.snappy) { expanded.toggle() }
        } label: {
            Image(systemName: "chevron.down")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.ink3)
                .rotationEffect(.degrees(expanded ? 180 : 0))
                .frame(width: 24)
                .contentShape(Rectangle().inset(by: -10))
        }
        .buttonStyle(.plain)
        .opacity(shown ? 1 : 0)
        .disabled(!shown)
        .accessibilityHidden(!shown)
        .accessibilityLabel(expanded ? "Hide report" : "Show report")
        .accessibilityIdentifier("subagent-report-\(subagent.id)")
    }

    private func ran(_ state: SubagentState, now: Date) -> some View {
        Text(PillWords.elapsed(SubagentWords.ran(subagent, state: state, now: now)))
            .font(.subheadline)
            .monospacedDigit()
            .foregroundStyle(Palette.ink2)
            .fixedSize()
    }
}
