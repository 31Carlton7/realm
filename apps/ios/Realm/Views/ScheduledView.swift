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

    /// The column's short form of a moment: "Today 9:00 AM", "Friday 4:00 PM" within the week, the date
    /// alone past it, since a fortnight out the day is the part that matters.
    static func short(_ millis: Millis, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let date = Date(timeIntervalSince1970: millis / 1000)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        let style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        let time = date.formatted(style.hour().minute())
        switch days {
        case 0: return "Today \(time)"
        case 1: return "Tomorrow \(time)"
        case -1: return "Yesterday \(time)"
        case 2..<7: return "\(date.formatted(style.weekday(.wide))) \(time)"
        case -6 ..< -1: return "\(date.formatted(style.weekday(.abbreviated))) \(time)"
        default:
            let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
            return date.formatted(sameYear ? style.month(.abbreviated).day() : style.month(.abbreviated).day().year())
        }
    }

    /// The one word a row ends on: what the Repeat menu calls its cadence, or Once, or Custom.
    static func cadence(_ task: ScheduledTask) -> String {
        guard let cadence = task.cadence else { return task.when }
        switch cadence.repeat {
        case .once: return "Once"
        case .hourly: return "Hourly"
        case .daily: return "Daily"
        case .weekdays: return "Weekdays"
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        case .custom: return "Custom"
        }
    }

    /// A row's line: when it runs next, then how often. "Tomorrow 9:00 AM · Daily", "Paused · Weekdays".
    static func line(_ task: ScheduledTask, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
        let when: String
        if !task.enabled {
            when = "Paused"
        } else if let next = task.nextRunAt {
            when = short(next, now: now, calendar: calendar, locale: locale)
        } else if let last = task.lastRunAt {
            when = "Ran \(lowered(short(last, now: now, calendar: calendar, locale: locale)))"
        } else {
            when = "Finished"
        }
        return "\(when) · \(cadence(task))"
    }

    /// The relative word lowered for the middle of a sentence, and nothing else: a month and a weekday
    /// are proper nouns.
    static func lowered(_ words: String) -> String {
        for relative in ["Today", "Tomorrow", "Yesterday"] where words.hasPrefix(relative) {
            return relative.lowercased() + words.dropFirst(relative.count)
        }
        return words
    }

    /// An occurrence the Mac did not run since it last ran one, named rather than swallowed.
    static func missed(_ task: ScheduledTask, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String? {
        guard let skipped = task.lastSkippedAt, skipped > (task.lastRunAt ?? 0) else { return nil }
        return "Missed a run \(lowered(short(skipped, now: now, calendar: calendar, locale: locale)))"
    }

    /// What a task's runs start on, in the chip's words: "Claude · Opus 5.5", or a teammate's chat.
    static func target(_ task: ScheduledTask, agents: [AgentOptions], teammate: Teammate?) -> String {
        if task.teammateId != nil { return "\(teammate?.name ?? task.title)'s chat" }
        guard let kind = task.agentKind else { return "" }
        let agent = agents.first { $0.kind == kind }
        let name = agent?.name ?? AgentNames.label(kind)
        guard let model = task.model else { return name }
        return "\(name) · \(agent?.models.first { $0.id == model }?.label ?? model)"
    }

    /// A task with no run to show, in the Mac's words. An armed one's next run is already on the page.
    static func noRuns(_ task: ScheduledTask) -> String {
        if !task.enabled { return "No runs yet. This task is paused." }
        return task.nextRunAt == nil ? "No runs yet. It has nothing left to run." : "No runs yet."
    }

    /// A one-shot that has run has nothing left to pause.
    static func finished(_ task: ScheduledTask) -> Bool {
        task.enabled && task.nextRunAt == nil && task.cadence?.repeat == .once
    }

    /// Whether this phone can change the task: a Mac too old sends none of what the sheet edits.
    static func editable(_ task: ScheduledTask) -> Bool {
        task.cron != nil && task.cadence != nil
    }
}

/// The page's groups: what the Mac's Scheduled page lists under Upcoming, the teammates' check-ins the
/// Mac keeps on each teammate's sheet, and what it suggests, less anything taken up already.
struct TaskSections: Equatable {
    var upcoming: [ScheduledTask] = []
    var checkIns: [ScheduledTask] = []
    var suggested: [SuggestedTask] = []

    /// `spaces` is those of the profile Home shows; nil before Home is known. A search reads a task's
    /// name, its instructions and its cadence's words, since a person remembers what a task does.
    static func arranged(_ tasks: [ScheduledTask], suggested: [SuggestedTask], spaces: Set<String>?, query: String = "") -> TaskSections {
        let shown = tasks.filter { spaces?.contains($0.spaceId) ?? true }
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let found = words.isEmpty ? shown : shown.filter { task in
            "\(task.title)\n\(task.goal ?? "")\n\(task.when)\n\(ScheduleWords.cadence(task))".lowercased().contains(words)
        }
        return TaskSections(upcoming: found.filter { $0.teammateId == nil }, checkIns: found.filter { $0.teammateId != nil },
                            suggested: words.isEmpty ? suggested.filter { idea in !shown.contains { $0.title == idea.title } } : [])
    }
}

/// Every scheduled task on the Mac, as its Scheduled page lists them: under Upcoming its name, when it
/// runs next and how often, what it runs on and in which space, and how its last run went where that
/// is more than the ordinary; then the teammates' check-ins and what the page suggests. Pressed, a task
/// opens to read and change. Run now, Pause and Delete are also a swipe or a press-and-hold away.
struct ScheduledView: View {
    @Environment(AppModel.self) private var model
    @State private var query = ""
    /// What the sheet is open on.
    @State private var sheet: TaskSheetStart?

    private var spaces: [Space] {
        (model.store.home?.spaces ?? []).filter(model.profileChoice.includes)
    }

    var body: some View {
        let tasks = model.work.schedules
        let sections = TaskSections.arranged(tasks ?? [], suggested: model.work.suggested ?? [],
                                             spaces: model.store.home == nil ? nil : Set(spaces.map(\.id)), query: query)
        let searching = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        List {
            if tasks?.isEmpty == true, model.work.suggested != nil {
                ScheduleEmpty { sheet = .new(TaskDraft.blank(in: spaces, agents: model.agentList)) }
            }
            if !sections.upcoming.isEmpty {
                Section {
                    ForEach(sections.upcoming) { task in
                        TaskRow(task: task, leadsSection: task.id == sections.upcoming.first?.id) { sheet = .edit(task) }
                    }
                } header: {
                    SectionHead(title: "Upcoming") { EmptyView() }
                }
            }
            if !sections.checkIns.isEmpty {
                Section {
                    ForEach(sections.checkIns) { task in
                        TaskRow(task: task, leadsSection: task.id == sections.checkIns.first?.id) { sheet = .edit(task) }
                    }
                } header: {
                    SectionHead(title: "Check-ins") { EmptyView() }
                }
            }
            if !sections.suggested.isEmpty {
                Section {
                    ForEach(sections.suggested) { idea in
                        Button {
                            sheet = .new(TaskDraft.of(idea, in: spaces, agents: model.agentList))
                        } label: {
                            SuggestionLine(idea: idea, leadsSection: idea.id == sections.suggested.first?.id)
                        }
                        .fileRow()
                        .accessibilityIdentifier("task-idea-\(idea.title)")
                    }
                } header: {
                    SectionHead(title: "Suggested") { EmptyView() }
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(HomeView.sectionSpacing)
        .scrollContentBackground(.hidden)
        .background(Ground.transcript)
        .softEdges(ground: Ground.transcript)
        .overlay {
            if searching, sections.upcoming.isEmpty, sections.checkIns.isEmpty {
                NoResults(query: query, why: "Search reads each task's name, instructions and when it runs.")
            } else if tasks?.isEmpty == true, model.work.suggested == nil {
                ContentUnavailableView("No scheduled tasks", systemImage: WorkPage.scheduled.symbol,
                                       description: Text("Update Realm on your Mac to schedule one here."))
            } else if tasks == nil {
                Unreached(what: "Scheduled", working: model.isConnected && !model.work.unsupported)
            }
        }
        .navigationTitle("Scheduled")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.work.suggested != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New task", systemImage: "plus") { sheet = .new(TaskDraft.blank(in: spaces, agents: model.agentList)) }
                        .accessibilityIdentifier("task-new")
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .safeAreaBar(edge: .bottom) {
            if tasks?.isEmpty == false {
                SearchBar(prompt: "Search tasks", query: $query) { query = "" }
            }
        }
        .sheet(item: $sheet) { start in
            TaskSheet(start: start, spaces: spaces)
        }
        .task(id: model.channelGeneration) {
            async let team: Void = model.work.loadTeam()
            async let agents: Void = model.loadAgents()
            await model.work.refresh()
            _ = await (team, agents)
        }
        .refreshable { await model.work.refresh() }
    }
}

/// The page with no task yet: the shortest honest path to one, in the Mac's words.
private struct ScheduleEmpty: View {
    let start: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Schedule a task")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Palette.ink)
            Text("Realm starts an agent in one of your spaces on the clock you set, and keeps each run here to read and carry on.")
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
            Button("New task", action: start)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Palette.accentInk)
                .padding(.top, 2)
                .accessibilityIdentifier("task-new-empty")
        }
        .padding(.vertical, 12)
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
}

private struct SuggestionLine: View {
    let idea: SuggestedTask
    let leadsSection: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(idea.title)
                .font(.body)
                .foregroundStyle(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(idea.blurb)
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
                .lineLimit(2)
        }
        .padding(.vertical, 2)
        .padding(.top, leadsSection ? FileLine.fadeRoom : 0)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Pause, Resume, Run now and Delete, as the Mac's task card offers them, where a row and the task's own
/// page both reach them.
@MainActor
struct TaskActions {
    let model: AppModel

    func runNow(_ task: ScheduledTask) {
        Task {
            do {
                _ = try await model.work.runNow(task.id)
                model.show(toast: "Started “\(task.title)” on your Mac.")
            } catch {
                model.show(toast: "“\(task.title)” did not start. \(AppModel.describe(error))")
            }
        }
    }

    func setEnabled(_ enabled: Bool, _ task: ScheduledTask) {
        Task {
            do {
                if let teammate = task.teammateId {
                    try await model.work.setCheckIn(teammateId: teammate, CheckInEdit(enabled: enabled))
                } else {
                    try await model.work.update(task.id, TaskEdit(enabled: enabled))
                }
            } catch {
                model.show(toast: "“\(task.title)” did not \(enabled ? "resume" : "pause"). \(AppModel.describe(error))")
            }
        }
    }

    /// True where it went.
    func delete(_ task: ScheduledTask) async -> Bool {
        do {
            if let teammate = task.teammateId {
                try await model.work.setCheckIn(teammateId: teammate, nil)
            } else {
                try await model.work.deleteTask(task.id)
            }
            return true
        } catch {
            model.show(toast: "“\(task.title)” was not deleted. \(AppModel.describe(error))")
            return false
        }
    }

    static func deleteTitle(_ task: ScheduledTask) -> String {
        task.teammateId != nil ? "Delete \(task.title)'s check-in?" : "Delete \(task.title)?"
    }

    static func deleteMessage(_ task: ScheduledTask) -> String {
        task.teammateId != nil ? "It stops checking in. Its chat stays." : "Its runs and their sessions stay."
    }
}

/// The rows of a task's menu, the same on its list row and on its own page.
private struct TaskMenuItems: View {
    let task: ScheduledTask
    let actions: TaskActions
    let edit: () -> Void
    let delete: () -> Void

    var body: some View {
        Button("Run now", systemImage: "play", action: { actions.runNow(task) })
        if ScheduleWords.editable(task) {
            Button("Edit", systemImage: "pencil", action: edit)
            if !ScheduleWords.finished(task) {
                if task.enabled {
                    Button("Pause", systemImage: "pause", action: { actions.setEnabled(false, task) })
                } else {
                    Button("Resume", systemImage: "play.circle", action: { actions.setEnabled(true, task) })
                }
            }
            Divider()
            Button(task.teammateId != nil ? "Delete check-in…" : "Delete task…", systemImage: "trash", role: .destructive, action: delete)
        }
    }
}

/// One task as a line of the list. What it runs on is the agent's mark or the teammate's icon, and its
/// last run wears a word only where that run is more than the ordinary: amber for needs you or failed,
/// the spinner while it works. Its title is bold until the last run is read.
private struct TaskRow: View {
    let task: ScheduledTask
    let leadsSection: Bool
    let edit: () -> Void
    @Environment(AppModel.self) private var model
    @State private var deleting = false

    var body: some View {
        let actions = TaskActions(model: model)
        Button {
            model.path.append(.scheduledTask(task.id))
        } label: {
            TaskLine(task: task, leadsSection: leadsSection)
        }
        .fileRow()
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if ScheduleWords.editable(task) {
                Button("Delete", systemImage: "trash") { deleting = true }
                    .tint(Palette.dangerFill)
            }
            if ScheduleWords.editable(task), !ScheduleWords.finished(task) {
                Button(task.enabled ? "Pause" : "Resume", systemImage: task.enabled ? "pause" : "play.circle") { actions.setEnabled(!task.enabled, task) }
                    .tint(Palette.ink2)
            }
            Button("Run now", systemImage: "play.fill") { actions.runNow(task) }
                .tint(Palette.accentFill)
        }
        .contextMenu {
            TaskMenuItems(task: task, actions: actions, edit: edit) { deleting = true }
            if let session = task.lastRun?.sessionId {
                Button("Open last run", systemImage: "text.bubble") { model.path.append(.session(session)) }
            }
        }
        .accessibilityActions {
            Button("Run now") { actions.runNow(task) }
        }
        .accessibilityIdentifier("task-\(task.title)")
        .confirmationDialog(TaskActions.deleteTitle(task), isPresented: $deleting, titleVisibility: .visible) {
            Button(task.teammateId != nil ? "Delete check-in" : "Delete task", role: .destructive) {
                Task { _ = await actions.delete(task) }
            }
        } message: {
            Text(TaskActions.deleteMessage(task))
        }
    }
}

private struct TaskLine: View {
    let task: ScheduledTask
    let leadsSection: Bool
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let unread = task.lastRun?.unread ?? false
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.body.weight(unread ? .semibold : .regular))
                    .foregroundStyle(task.enabled ? Palette.ink : Palette.ink2)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 6 : 2)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(ScheduleWords.line(task, now: context.date))
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
                targetLine
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let run = task.lastRun {
                TaskRunWord(state: RunState(run.state))
            }
        }
        .padding(.vertical, 2)
        .padding(.top, leadsSection ? FileLine.fadeRoom : 0)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(ScheduleWords.spoken(task))
    }

    private var targetLine: some View {
        let teammate = task.teammateId.flatMap { model.work.teammate($0) }
        let words = ScheduleWords.target(task, agents: model.agentList?.agents ?? [], teammate: teammate)
        let continues = task.newSessionPerRun == false && task.teammateId == nil
        return HStack(spacing: 5) {
            if let teammate {
                TeammateMark(icon: teammate.icon, size: 14)
            } else if let kind = task.agentKind {
                AgentMark(kind: kind, size: 13, relativeTo: .footnote)
            }
            Text(([words, continues ? "Same session" : "", task.spaceName]).filter { !$0.isEmpty }.joined(separator: " · "))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .font(.footnote)
        .foregroundStyle(Palette.ink3)
    }
}

/// What a row says of its last run. A run that finished is the ordinary case and wears nothing.
private struct TaskRunWord: View {
    let state: RunState

    var body: some View {
        if state != .finished {
            HStack(spacing: 4) {
                if state == .running {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: state.symbol).symbolRenderingMode(.hierarchical)
                }
                Text(state.word)
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(state.tone.agentColor)
            .fixedSize()
        }
    }
}

/// A task, open: when it runs, what it is told, what it runs on and where, and its last run, which opens
/// the session it ran in. Edit is on the bar, and the Mac's other actions are in the menu beside it.
struct ScheduledTaskView: View {
    let taskId: String
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var editing: TaskSheetStart?
    @State private var deleting = false

    private var spaces: [Space] {
        (model.store.home?.spaces ?? []).filter(model.profileChoice.includes)
    }

    var body: some View {
        let task = model.work.schedules?.first { $0.id == taskId }
        Group {
            if let task {
                page(task)
            } else {
                ContentUnavailableView("This task is not on your Mac any more", systemImage: WorkPage.scheduled.symbol)
            }
        }
        .background(Ground.transcript)
        .navigationTitle(task?.teammateId != nil ? "Check-in" : "Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let task, ScheduleWords.editable(task) {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit", systemImage: "pencil") { editing = .edit(task) }
                        .accessibilityIdentifier("task-edit")
                }
                .sharedBackgroundVisibility(.hidden)
            }
            if let task {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu("More", systemImage: "ellipsis") {
                        TaskMenuItems(task: task, actions: TaskActions(model: model), edit: { editing = .edit(task) }) { deleting = true }
                    }
                    .accessibilityIdentifier("task-more")
                    .confirmationDialog(TaskActions.deleteTitle(task), isPresented: $deleting, titleVisibility: .visible) {
                        Button(task.teammateId != nil ? "Delete check-in" : "Delete task", role: .destructive) {
                            Task {
                                if await TaskActions(model: model).delete(task) { dismiss() }
                            }
                        }
                    } message: {
                        Text(TaskActions.deleteMessage(task))
                    }
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .sheet(item: $editing) { start in
            TaskSheet(start: start, spaces: spaces)
        }
        .task(id: model.channelGeneration) {
            async let team: Void = model.work.loadTeam()
            async let agents: Void = model.loadAgents()
            _ = await (team, agents)
        }
        .refreshable { await model.work.refresh() }
    }

    private func page(_ task: ScheduledTask) -> some View {
        let teammate = task.teammateId.flatMap { model.work.teammate($0) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(task.title)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                    Text(task.enabled ? task.when : "\(task.when) · Paused")
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink2)
                }
                if let goal = task.goal {
                    Text(goal)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                        .textSelection(.enabled)
                }
                facts(task, teammate: teammate)
                runRow(task, teammate: teammate)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .softEdges(ground: Ground.transcript)
    }

    private func facts(_ task: ScheduledTask, teammate: Teammate?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if task.enabled, let next = task.nextRunAt {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    TaskFact(words: "Next run \(ScheduleWords.phrase(next, now: context.date))") { Image(systemName: "clock") }
                }
            }
            if let missed = ScheduleWords.missed(task, now: .now) {
                TaskFact(words: missed, tone: Palette.orange) { Image(systemName: "exclamationmark.triangle") }
            }
            let target = ScheduleWords.target(task, agents: model.agentList?.agents ?? [], teammate: teammate)
            if task.teammateId != nil {
                TaskFact(words: target) { TeammateMark(icon: teammate?.icon, size: 16) }
            } else if let kind = task.agentKind {
                TaskFact(words: target) { AgentMark(kind: kind) }
            }
            if !task.spaceName.isEmpty {
                let space = model.store.home?.spaces.first { $0.id == task.spaceId }
                TaskFact(words: task.spaceName) {
                    if let space { SpaceGlyph(space: space, size: 15, relativeTo: .subheadline) } else { Image(systemName: "square.stack") }
                }
            }
            if task.teammateId == nil {
                TaskFact(words: "Full access") { Image(systemName: "lock.open") }
                if task.newSessionPerRun == false {
                    TaskFact(words: "Each run continues the last run’s session") { Image(systemName: "arrow.turn.down.right") }
                }
                if task.archiveSucceeded == true {
                    TaskFact(words: "Archives successful runs") { Image(systemName: "archivebox") }
                }
            }
        }
    }

    /// The last run, which opens the session it ran in; a check-in's turns are in the teammate's chat.
    @ViewBuilder
    private func runRow(_ task: ScheduledTask, teammate: Teammate?) -> some View {
        if let teammate {
            Button {
                Task { await model.openTeammate(teammate) }
            } label: {
                LastRunLine(title: "Open \(teammate.name)'s chat", detail: task.lastRunAt.map { "Last checked in \(ScheduleWords.phrase($0, now: .now))" }, state: nil, error: nil, opens: true)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task-chat")
        } else if let run = task.lastRun {
            let state = RunState(run.state)
            let detail = task.lastRunAt.map { ScheduleWords.when($0, now: .now) }
            Button {
                if let session = run.sessionId { model.path.append(.session(session)) }
            } label: {
                LastRunLine(title: "Last run", detail: detail, state: state, error: run.error, opens: run.sessionId != nil)
            }
            .buttonStyle(.plain)
            .disabled(run.sessionId == nil)
            .accessibilityHint(run.sessionId != nil ? "Opens the session it ran in" : "")
            .accessibilityIdentifier("task-last-run")
        } else {
            Text(ScheduleWords.noRuns(task))
                .font(.subheadline)
                .foregroundStyle(Palette.ink2)
        }
    }
}

/// A line of what a task works with: its mark in a column of its own, so the words line up.
private struct TaskFact<Mark: View>: View {
    let words: String
    var tone: Color = Palette.ink2
    @ViewBuilder let mark: Mark
    @ScaledMetric(relativeTo: .subheadline) private var markWidth: CGFloat = 20

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            mark
                .frame(width: markWidth)
                .accessibilityHidden(true)
            Text(words)
        }
        .font(.subheadline)
        .foregroundStyle(tone)
    }
}

/// The last run as a row a person presses: the same soft card a teammate's computer lists work on.
private struct LastRunLine: View {
    let title: String
    let detail: String?
    let state: RunState?
    let error: String?
    let opens: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                    if let state { TaskRunWord(state: state) }
                }
                if let detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                }
                if let error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Palette.ink2)
                        .lineLimit(4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if opens {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Palette.ink3)
                    .accessibilityHidden(true)
            }
        }
        .padding(14)
        .background(Fill.card, in: RoundedRectangle(cornerRadius: Radius.card - 4, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
