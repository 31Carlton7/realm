import RealmKit
import SwiftUI

/// A span as a countdown reads, as the Mac's Usage page writes it: "3d 4h", "1h 12m", "12m", "under a
/// minute"; spoken in whole words.
enum Countdown {
    static func text(_ interval: TimeInterval, spoken: Bool = false) -> String {
        guard interval >= 60 else { return "under a minute" }
        let minutes = Int(interval / 60)
        let days = minutes / 1440, hours = minutes % 1440 / 60, mins = minutes % 60
        let parts: [(Int, String, String)] = days > 0 ? [(days, "d", "day"), (hours, "h", "hour")]
            : hours > 0 ? [(hours, "h", "hour"), (mins, "m", "minute")] : [(mins, "m", "minute")]
        return parts.enumerated().filter { $0.offset == 0 || $0.element.0 > 0 }.map { _, part in
            spoken ? "\(part.0) \(part.2)\(part.0 == 1 ? "" : "s")" : "\(part.0)\(part.1)"
        }.joined(separator: " ")
    }
}

/// One window of a plan as the page says it: a bar where the provider said how full it is, and under
/// it "62% used · resets in 2h 10m". A window whose reset has passed since it was read is said to have
/// reset rather than drawn at the figure it had, and one with no figure gets no bar: drawn empty,
/// either would read as plenty left.
struct WindowReading: Equatable {
    /// How full the bar is, 0 to 1; nil where none is drawn.
    let fraction: Double?
    let words: String
    let spoken: String

    init(_ window: PlanWindow, now: Date) {
        let nowMillis = now.timeIntervalSince1970 * 1000
        if let resetsAt = window.resetsAt, resetsAt <= nowMillis {
            fraction = nil
            words = "Reset since this reading"
            spoken = words
            return
        }
        let left = window.resetsAt.map { ($0 - nowMillis) / 1000 }
        let used = window.usedPercent.map { Int(min(100, max(0, $0)).rounded()) }
        fraction = used.map { Double($0) / 100 }
        let figure = used.map { "\($0)% used" } ?? "Not reported"
        words = ([figure] + (left.map { ["resets in \(Countdown.text($0))"] } ?? [])).joined(separator: " · ")
        let spokenFigure = used.map { "\($0) percent used" } ?? "Not reported"
        spoken = ([spokenFigure] + (left.map { ["resets in \(Countdown.text($0, spoken: true))"] } ?? [])).joined(separator: ", ")
    }
}

/// A window's bar in the warning's tone where the provider warned about it, as the Mac's PlanCard draws
/// it: orange nearing the limit, red past it; the accent otherwise.
enum WindowTone {
    static func of(_ plan: PlanLimits, _ window: PlanWindow) -> Color {
        guard plan.warns(window) else { return Palette.accent }
        return plan.alertLevel == "exceeded" ? Palette.red : Palette.orange
    }
}

/// What a plan is called and how old its reading is.
enum PlanWords {
    /// "Claude Max": the agent leads, since several providers' plans sit on one page, and the tier is
    /// as the provider spells it but for its first letter.
    static func title(_ plan: PlanLimits) -> String {
        guard let tier = plan.plan?.trimmingCharacters(in: .whitespaces), !tier.isEmpty else { return plan.agentName }
        return "\(plan.agentName) \(tier.prefix(1).uppercased())\(tier.dropFirst())"
    }

    /// "As of 12m ago", for a reading more than a minute and a half old; nil for a fresh one.
    static func age(_ at: Millis, now: Date) -> String? {
        let interval = now.timeIntervalSince1970 - at / 1000
        guard at > 0, interval >= 90 else { return nil }
        return "As of \(Countdown.text(interval)) ago"
    }
}

/// US dollars as the Mac writes them: "$0.00", "$0.0042" under a cent, "$12.34", "$1,234.56".
enum Money {
    static func text(_ usd: Double, locale: Locale = .current) -> String {
        let places = usd != 0 && abs(usd) < 0.01 ? 4 : 2
        return "$" + usd.formatted(.number.precision(.fractionLength(places)).locale(locale))
    }
}

/// This month's spend as the page says it: against the budget, with a bar, where the Mac has one; the
/// sum alone where it has none.
struct SpendReading: Equatable {
    /// How the spend stands against the budget, as the Mac's budget meter draws it.
    enum Level: Equatable {
        case within, near, over
    }

    let total: String
    /// How far into the budget, 0 to 1; nil without a budget.
    let fraction: Double?
    let level: Level?
    let words: String

    init(_ spend: Spend, locale: Locale = .current) {
        total = Money.text(spend.monthToDate, locale: locale)
        guard let budget = spend.budget, budget > 0 else {
            fraction = nil
            level = nil
            words = "No budget is set on your Mac."
            return
        }
        let ratio = spend.monthToDate / budget
        fraction = min(1, max(0, ratio))
        level = ratio >= 1 ? .over : ratio >= 0.8 ? .near : .within
        let limit = Money.text(budget, locale: locale)
        words = ratio > 1
            ? "Over the \(limit) budget by \(Money.text(spend.monthToDate - budget, locale: locale))"
            : "\(Int((ratio * 100).rounded()))% of the \(limit) budget"
    }

    var tone: Color {
        switch level {
        case .near: Palette.orange
        case .over: Palette.red
        case .within, nil: Palette.accent
        }
    }
}

/// Usage, as the Mac's Usage page has it: each agent's plan with its windows as bars and the provider's
/// warning in its words; then this month's spend against its budget, and the sessions that cost the
/// most, each opening; then why the other agents have nothing to show. Pulled down, it is read again.
struct UsageView: View {
    @Environment(AppModel.self) private var model
    @State private var problem: String?

    var body: some View {
        let usage = model.work.usage
        let reporting = usage?.limits.filter { $0.unavailable == nil && !$0.windows.isEmpty } ?? []
        let silent = usage?.limits.filter { $0.unavailable != nil || $0.windows.isEmpty } ?? []
        List {
            if let usage {
                ForEach(reporting) { plan in
                    PlanSection(plan: plan)
                }
                SpendSection(spend: usage.spend)
                // Last, the agents with nothing to draw: most can never report a plan, and each says why.
                if !silent.isEmpty {
                    Section {
                        ForEach(silent) { plan in
                            SilentPlanRow(plan: plan)
                        }
                    } header: {
                        Text(reporting.isEmpty ? "Plans" : "Other agents")
                            .textCase(nil)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Ground.grouped)
        .overlay {
            if usage == nil {
                if model.work.unsupported || !model.isConnected {
                    ContentUnavailableView {
                        Label("Usage is on your Mac", systemImage: "laptopcomputer")
                    } description: {
                        Text(model.work.unsupported ? "Update Realm on your Mac to see it here."
                             : "This iPhone shows it while your Mac is connected.")
                    }
                } else if let problem {
                    ContentUnavailableView("Usage did not load", systemImage: "exclamationmark.triangle", description: Text(problem))
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        // Read on the way in, and again on each new channel to the Mac.
        .task(id: model.channelGeneration) { await load(saying: false) }
        .refreshable { await load(saying: true) }
    }

    /// Reads it again. Where it does not come, the page says why while it has nothing to show, and a
    /// toast says so over a reading it keeps when that was asked for.
    private func load(saying: Bool) async {
        do {
            try await model.work.loadUsage()
            problem = nil
        } catch is CancellationError {
            // Left before the Mac answered.
        } catch {
            problem = AppModel.describe(error)
            if saying, model.work.usage != nil { model.show(toast: "Usage did not update. \(AppModel.describe(error))") }
        }
    }
}

/// One agent's plan: its windows, the provider's warning where it gave one, and how old the reading is.
private struct PlanSection: View {
    let plan: PlanLimits

    var body: some View {
        Section {
            if let alert = plan.alert {
                Label {
                    Text(alert)
                        .foregroundStyle(Palette.ink)
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Palette.orange)
                }
                .font(.subheadline.weight(.medium))
                .listRowBackground(Fill.card)
            }
            ForEach(plan.windows) { window in
                WindowRow(window: window, tone: WindowTone.of(plan, window))
                    .listRowBackground(Fill.card)
            }
        } header: {
            // The page's other heads' face, with the agent's mark beside its plan's name.
            HStack(spacing: 6) {
                AgentMark(kind: plan.agent, mark: plan.agentMark, colored: true, size: 17, relativeTo: .headline)
                Text(PlanWords.title(plan))
            }
            .textCase(nil)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        } footer: {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                if let age = PlanWords.age(plan.at, now: context.date) { Text(age) }
            }
        }
    }
}

/// A window of a plan: its name, its bar where it has a figure, and what is used and when it resets,
/// counting down while the page is open.
private struct WindowRow: View {
    let window: PlanWindow
    let tone: Color

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let reading = WindowReading(window, now: context.date)
            VStack(alignment: .leading, spacing: 8) {
                Text(window.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                if let fraction = reading.fraction {
                    Gauge(value: fraction) { EmptyView() }
                        .gaugeStyle(.linearCapacity)
                        .tint(tone)
                        .labelsHidden()
                }
                Text(reading.words)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(Palette.ink2)
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(window.label) window")
            .accessibilityValue(reading.spoken)
        }
    }
}

/// A plan with nothing to draw, in one line: the agent, and why.
private struct SilentPlanRow: View {
    let plan: PlanLimits

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            AgentMark(kind: plan.agent, mark: plan.agentMark, size: 15, relativeTo: .subheadline)
            VStack(alignment: .leading, spacing: 2) {
                Text(PlanWords.title(plan))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink)
                Text(plan.unavailable ?? "Nothing reported yet.")
                    .font(.footnote)
                    .foregroundStyle(Palette.ink2)
            }
        }
        .listRowBackground(Fill.card)
        .accessibilityElement(children: .combine)
    }
}

/// This month's spend against the budget set on the Mac, then the sessions that cost the most, each
/// opening its session.
private struct SpendSection: View {
    let spend: Spend

    var body: some View {
        let reading = SpendReading(spend)
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(reading.total)
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Palette.ink)
                if let fraction = reading.fraction {
                    Gauge(value: fraction) { EmptyView() }
                        .gaugeStyle(.linearCapacity)
                        .tint(reading.tone)
                        .labelsHidden()
                }
                Text(reading.words)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(Palette.ink2)
            }
            .padding(.vertical, 4)
            .listRowBackground(Fill.card)
            .accessibilityElement(children: .combine)
        } header: {
            Text("\(Date().formatted(.dateTime.month(.wide))) so far")
                .textCase(nil)
        }
        if !spend.topSessions.isEmpty {
            Section {
                ForEach(spend.topSessions) { session in
                    NavigationLink(value: Route.session(session.id)) {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.title.isEmpty ? "Untitled session" : session.title)
                                    .font(.body)
                                    .foregroundStyle(Palette.ink)
                                    .lineLimit(2)
                                Text(session.spaceName)
                                    .font(.footnote)
                                    .foregroundStyle(Palette.ink2)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            Text(Money.text(session.cost))
                                .font(.subheadline)
                                .monospacedDigit()
                                .foregroundStyle(Palette.ink2)
                        }
                    }
                    .listRowBackground(Fill.card)
                }
            } header: {
                Text("Costliest sessions")
                    .textCase(nil)
            }
        }
    }
}
