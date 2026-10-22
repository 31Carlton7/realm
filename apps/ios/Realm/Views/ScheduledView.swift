import RealmKit
import SwiftUI

/// How a scheduled task's last run went, in the words the Mac's Scheduled page wears: a glyph and a
/// word in its tone. The Mac says it in words; the names of its runs' states are read too.
enum RunState: Equatable {
    case starting, running, needsYou, done, failed, expired, stopped
    /// A state this phone has no word of its own for, in the Mac's.
    case other(String)

    init(_ state: String) {
        switch state.lowercased() {
        case "queued", "starting": self = .starting
        case "running": self = .running
        case "blocked", "needs you", "waiting": self = .needsYou
        case "succeeded", "done", "finished": self = .done
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
        case .done: "Done"
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
        case .done: "checkmark.circle.fill"
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
        case .done: .done
        case .failed, .expired: .failed
        case .starting, .stopped, .other: .quiet
        }
    }

    /// The run is over, and what it left can be read.
    var isFinished: Bool {
        switch self {
        case .done, .failed, .expired, .stopped: true
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

/// One task as a line of the list: its space and when it runs, with its last run's state at the end;
/// its title; then when it runs next. A task that has run opens the session it ran in.
private struct TaskRow: View {
    let task: ScheduledTask
    let runNow: () -> Void

    var body: some View {
        Group {
            if let session = task.lastRun?.sessionId {
                NavigationLink(value: Route.session(session)) {
                    TaskLine(task: task)
                }
                .accessibilityHint("Opens the session its last run ran in")
            } else {
                TaskLine(task: task)
            }
        }
        .listRowBackground(Color.clear)
        .listRowSeparatorTint(Palette.divider)
        .alignmentGuide(.listRowSeparatorLeading) { $0[.leading] }
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let unread = task.lastRun?.unread ?? false
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Circle()
                .fill(unread ? Palette.accent : .clear)
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 4) {
                let line = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                line {
                    Text([task.spaceName, task.when].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                        .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? nil : .infinity, alignment: .leading)
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
                }
                Text(task.title)
                    .font(.body.weight(unread ? .semibold : .regular))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 6 : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(ScheduleWords.next(task, now: context.date))
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ScheduleWords.spoken(task))
    }
}
