import RealmKit
import SwiftUI

/// How a scheduled task's last run went, in the words the Mac's Scheduled page and a space's Tasks
/// wear: a glyph and a word in its tone. The Mac says it in words; its runs' own states are read too.
enum RunState: Equatable {
    case starting, running, needsYou, finished, failed, expired, stopped
    /// A state this phone has no word of its own for, in the Mac's.
    case other(String)

    init(_ state: String) {
        switch state.lowercased() {
        case "queued", "starting": self = .starting
        case "running": self = .running
        case "blocked", "needs you", "waiting": self = .needsYou
        case "succeeded", "finished", "done": self = .finished
        case "failed": self = .failed
        case "expired": self = .expired
        case "cancelled", "stopped": self = .stopped
        default: self = .other(state)
        }
    }

    var word: String {
        switch self {
        case .starting: "Starting"
        case .running: "Running"
        case .needsYou: "Needs you"
        case .finished: "Finished"
        case .failed: "Failed"
        case .expired: "Expired"
        case .stopped: "Stopped"
        case .other(let word): word.prefix(1).uppercased() + word.dropFirst()
        }
    }

    var symbol: String {
        switch self {
        case .starting: "circle.dotted"
        case .running: "progress.indicator"
        case .needsYou: "hand.raised.fill"
        case .finished: "checkmark.circle.fill"
        case .failed: "exclamationmark.circle.fill"
        case .expired: "clock.badge.exclamationmark"
        case .stopped: "stop.circle.fill"
        case .other: "circle.fill"
        }
    }

    var tone: Tone {
        switch self {
        case .running: .working
        case .needsYou: .waiting
        case .finished: .done
        case .failed, .expired: .failed
        case .starting, .stopped, .other: .quiet
        }
    }

    /// The run is over, and what it left can be read.
    var isFinished: Bool {
        switch self {
        case .finished, .failed, .expired, .stopped: true
        case .starting, .running, .needsYou, .other: false
        }
    }
}

/// The tasks in the order the Mac's Scheduled page has them: what runs soonest first, then what is
/// paused or will not run again, the most recently run first.
enum TaskOrder {
    static func nextFirst(_ tasks: [ScheduledTask]) -> [ScheduledTask] {
        let armed = { (task: ScheduledTask) in task.enabled && task.nextRunAt != nil }
        return tasks.stablySorted { a, b in
            if armed(a) != armed(b) { return armed(a) }
            if armed(a) { return a.nextRunAt! < b.nextRunAt! }
            return (a.lastRunAt ?? 0) > (b.lastRunAt ?? 0)
        }
    }
}

/// What the Scheduled page says of a task's runs.
enum ScheduleWords {
    /// Runs that finished and have not been read: what Home's head counts.
    static func unreadResults(_ tasks: [ScheduledTask]) -> Int {
        tasks.filter { task in task.lastRun.map { $0.unread && RunState($0.state).isFinished } ?? false }.count
    }

    /// "1 scheduled result", "2 scheduled results"
    static func results(_ count: Int) -> String {
        count == 1 ? "1 scheduled result" : "\(count) scheduled results"
    }

    /// When it runs next, as the end of a row: "Next tomorrow at 9:00 am", "Paused", or when it last
    /// ran where it will not run again.
    static func next(_ task: ScheduledTask, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        if !task.enabled { return "Paused" }
        if let next = task.nextRunAt { return "Next \(phrase(next, now: now, calendar: calendar, locale: locale))" }
        if let last = task.lastRunAt { return "Ran \(phrase(last, now: now, calendar: calendar, locale: locale))" }
        return "Finished"
    }

    /// A moment as a person asks after one: "Today at 9:00 AM", "Tomorrow at 9:00 AM", "Friday at 9:00 AM"
    /// within the week ahead, and the date past it, "Oct 30 at 9:00 AM".
    static func when(_ millis: Millis, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: millis / 1000)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let time = date.formatted(style.hour().minute())
        switch days {
        case 0: return "Today at \(time)"
        case 1: return "Tomorrow at \(time)"
        case -1: return "Yesterday at \(time)"
        case 2..<7: return "\(date.formatted(style.weekday(.wide))) at \(time)"
        default: return "\(date.formatted(style.month(.abbreviated).day())) at \(time)"
        }
    }

    /// The same moment inside a sentence: only the relative words and the meridiem are lowered, since a
    /// weekday and a month are proper nouns.
    static func phrase(_ millis: Millis, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        // Simple word boundaries: Unicode's join a time to the narrow space before its meridiem.
        var words = when(millis, now: now, calendar: calendar, locale: locale)
            .replacing(/\b(AM|PM)\b/.wordBoundaryKind(.simple)) { $0.output.0.lowercased() }
        for relative in ["Today", "Tomorrow", "Yesterday"] where words.hasPrefix(relative) {
            words = relative.lowercased() + words.dropFirst(relative.count)
        }
        return words
    }

    /// A row as VoiceOver reads it: the title, then everything the row shows, in words.
    static func spoken(_ task: ScheduledTask, now: Date = Date()) -> String {
        var parts = [task.title]
        if let run = task.lastRun {
            parts.append("Last run \(RunState(run.state).word)")
            if run.unread { parts.append("Unread") }
        }
        parts += [task.spaceName, task.when, next(task, now: now)]
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// Every scheduled task on the Mac, as its Scheduled page lists them: its title, its space, when it
/// runs and when next, how its last run went, and a mark while that run is unread. Pressed, a task
/// opens the session its last run ran in; Run now is a swipe away, and in its menu.
struct ScheduledView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let tasks = model.work.schedules
        List {
            ForEach(tasks ?? []) { task in
                TaskRow(task: task) { runNow(task) }
            }
        }
        .listStyle(.plain)
        .listRowSpacing(12)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .overlay {
            if let tasks, tasks.isEmpty {
                ContentUnavailableView("No scheduled tasks", systemImage: "calendar.badge.clock",
                                       description: Text("Schedule one in Realm on your Mac, and it shows here."))
            } else if tasks == nil {
                Unreached(what: "Scheduled", working: model.isConnected && !model.work.unsupported)
            }
        }
        .navigationTitle("Scheduled")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model.channelGeneration) { await model.work.refresh() }
        .refreshable { await model.work.refresh() }
    }

    private func runNow(_ task: ScheduledTask) {
        Task {
            do {
                _ = try await model.work.runNow(task.id)
                model.show(toast: "Started “\(task.title)” on your Mac.")
            } catch {
                model.show(toast: "“\(task.title)” did not start. \(AppModel.describe(error))")
            }
        }
    }
}

/// One task as Manus's scheduled tasks are drawn: a card with its title and where and when it runs,
/// then, under a line, when it runs next, its last run's state and a menu with Run now. A task that
/// has run opens the session it ran in.
private struct TaskRow: View {
    let task: ScheduledTask
    let runNow: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let session = task.lastRun?.sessionId {
                // A press rather than a link, so no chevron stands outside the card.
                Button {
                    model.path.append(Route.session(session))
                } label: {
                    TaskLine(task: task, runNow: runNow)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the session its last run ran in")
            } else {
                TaskLine(task: task, runNow: runNow)
            }
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Run now", systemImage: "play.fill", action: runNow)
                .tint(Palette.accentFill)
        }
        .contextMenu {
            Button("Run now", systemImage: "play.fill", action: runNow)
        }
        .accessibilityActions {
            Button("Run now", action: runNow)
        }
        .accessibilityIdentifier("task-\(task.id)")
    }
}

private struct TaskLine: View {
    let task: ScheduledTask
    let runNow: () -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let unread = task.lastRun?.unread ?? false
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if unread {
                    Circle()
                        .fill(Palette.accent)
                        .frame(width: 9, height: 9)
                }
                Text(task.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 6 : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Text([task.spaceName, task.when].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
                .padding(.top, 4)
            Rectangle()
                .fill(Palette.line)
                .frame(height: 1)
                .padding(.vertical, 12)
                .accessibilityHidden(true)
            HStack(alignment: .center, spacing: 8) {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(ScheduleWords.next(task, now: context.date))
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink)
                }
                if let run = task.lastRun {
                    let state = RunState(run.state)
                    HStack(spacing: 4) {
                        Image(systemName: state.symbol)
                            .symbolRenderingMode(.hierarchical)
                            .restingPulse(when: state == .running)
                        Text(state.word)
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(state.tone.color)
                    .fixedSize()
                }
                Spacer(minLength: 0)
                Menu {
                    Button("Run now", systemImage: "play.fill", action: runNow)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                        .frame(width: 44, height: 32)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("More")
            }
        }
        .padding(16)
        .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.card - 4, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(ScheduleWords.spoken(task))
    }
}
