import RealmKit
import SwiftUI

/// What the sheet opens on: a task to edit, or a draft to create from.
enum TaskSheetStart: Identifiable {
    case new(TaskDraft)
    case edit(ScheduledTask)

    var id: String {
        switch self {
        case .new: "new"
        case .edit(let task): task.id
        }
    }
}

/// How often a task runs, as the Mac's Repeat menu lists it.
enum TaskEvery: String, CaseIterable, Identifiable {
    case hourly, daily, weekdays, weekly, monthly, custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .hourly: "Hourly"
        case .daily: "Daily"
        case .weekdays: "Weekdays"
        case .weekly: "Weekly"
        case .monthly: "Monthly"
        case .custom: "Custom (cron)"
        }
    }
}

/// Everything the sheet holds, in the Mac's sheet's terms. The expression is derived from it, so the two
/// can never disagree.
struct TaskDraft: Equatable {
    var title = ""
    var goal = ""
    /// The Repeat task switch: off is a single run at `moment`.
    var repeats = true
    var every = TaskEvery.daily
    var hour = 9
    var minute = 0
    /// Minute past the hour, for hourly.
    var pastHour = 0
    /// 0 is Sunday, as cron has it.
    var weekday: Int
    var monthDay = 1
    /// The expression itself, for Custom.
    var cron = "0 9 * * *"
    var moment: Date
    var spaceId: String
    /// The teammate this is a check-in of; nil for a task an agent runs.
    var teammateId: String?
    var agentKind: String?
    var model: String?
    var effort: String?
    var newSessionPerRun = true
    var archiveSucceeded = false

    /// A new task's starting point, as the Mac's: every day at nine, since an agent should start when
    /// someone is awake to answer it, or tomorrow at nine for a single run.
    init(spaceId: String, agentKind: String?, now: Date = .now, calendar: Calendar = .current) {
        self.spaceId = spaceId
        self.agentKind = agentKind
        weekday = calendar.component(.weekday, from: now) - 1
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
        moment = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: tomorrow) ?? tomorrow
    }

    static func blank(in spaces: [Space], agents: AgentList?) -> TaskDraft {
        TaskDraft(spaceId: spaces.first?.id ?? "", agentKind: defaultAgent(agents))
    }

    static func of(_ idea: SuggestedTask, in spaces: [Space], agents: AgentList?) -> TaskDraft {
        var draft = blank(in: spaces, agents: agents)
        draft.title = idea.title
        draft.goal = idea.goal
        draft.read(idea.cadence, cron: draft.cron)
        return draft
    }

    /// The agent a new task starts on: the Mac's own where it can run, else the first that can.
    static func defaultAgent(_ agents: AgentList?) -> String? {
        agents.flatMap(NewSessionDefaults.agent)?.kind ?? agents?.defaultAgent
    }

    /// The draft a saved task opens as: the same rows, read back off what the Mac says its expression is.
    init(_ task: ScheduledTask, now: Date = .now, calendar: Calendar = .current) {
        self.init(spaceId: task.spaceId, agentKind: task.agentKind, now: now, calendar: calendar)
        title = task.title
        goal = task.goal ?? ""
        teammateId = task.teammateId
        model = task.model
        effort = task.effort
        newSessionPerRun = task.newSessionPerRun ?? true
        archiveSucceeded = task.archiveSucceeded ?? false
        if let cadence = task.cadence { read(cadence, cron: task.cron ?? cron) }
    }

    private mutating func read(_ cadence: TaskCadence, cron expression: String) {
        cron = expression
        switch cadence.repeat {
        case .once:
            repeats = false
            if let at = cadence.at { moment = Date(timeIntervalSince1970: at / 1000) }
        case .custom:
            every = .custom
        case .hourly:
            every = .hourly
            pastHour = cadence.minute ?? 0
        case .daily, .weekdays, .weekly, .monthly:
            every = TaskEvery(rawValue: cadence.repeat.rawValue) ?? .daily
            hour = cadence.hour ?? hour
            minute = cadence.minute ?? minute
            weekday = cadence.weekday ?? weekday
            monthDay = cadence.day ?? monthDay
        }
    }

    /// The expression the draft writes: the single thing the Mac is told about when.
    var expression: String {
        if !repeats { return "once:\(Int64(moment.timeIntervalSince1970 * 1000))" }
        switch every {
        case .hourly: return "\(pastHour) * * * *"
        case .daily: return "\(minute) \(hour) * * *"
        case .weekdays: return "\(minute) \(hour) * * 1-5"
        case .weekly: return "\(minute) \(hour) * * \(weekday)"
        case .monthly: return "\(minute) \(hour) \(monthDay) * *"
        case .custom: return cron.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    /// Custom is "write the expression yourself", so it opens on the one the menu was writing.
    mutating func choose(_ next: TaskEvery) {
        if next == .custom { cron = expression }
        every = next
    }

    /// The minutes the Minute row offers, and this draft's own where it is off them.
    var minuteChoices: [Int] {
        let grid = [0, 15, 30, 45]
        return grid.contains(pastHour) ? grid : (grid + [pastHour]).sorted()
    }

    var isCheckIn: Bool { teammateId != nil }

    /// `first` is when it would first fire, and nil where it never would. `kept` is the expression an
    /// edit opened on: while the draft still writes it, it needs no first run, since a one-shot that
    /// has run can still be renamed or told new things.
    func valid(first: Millis?, kept: String?) -> Bool {
        let named = isCheckIn || !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let told = isCheckIn || !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let runs = isCheckIn || agentKind != nil
        return named && told && runs && !spaceId.isEmpty && (first != nil || expression == kept)
    }

    /// The line under When, in the Mac's words: when the first run would be, before anything is saved,
    /// or why there would be none.
    func whenLine(first: Millis?, kept: String?, now: Date = .now, calendar: Calendar = .current, locale: Locale = .current) -> String {
        if let first {
            let phrase = ScheduleWords.phrase(first, now: now, calendar: calendar, locale: locale)
            if isCheckIn { return "Next check-in \(phrase)." }
            return repeats ? "First run \(phrase)." : "Runs once, \(phrase)."
        }
        if !repeats {
            return expression == kept ? "Its time has passed. Pick a new one to run it again." : "That time has already passed. Pick one ahead of now."
        }
        return "That expression will never run — check the five fields (minute, hour, day, month, weekday)."
    }

    /// What `schedules.create` is sent. The instructions go as typed: they are somebody's standing orders.
    func newTask() -> NewTask? {
        guard let agentKind else { return nil }
        return NewTask(spaceId: spaceId, title: title.trimmingCharacters(in: .whitespacesAndNewlines), goal: goal, cron: expression, agent: agentKind,
                       model: model, effort: effort, newSessionPerRun: newSessionPerRun, archiveSucceeded: archiveSucceeded)
    }

    /// What `schedules.update` is sent: only what changed since the sheet opened. Another agent, model or
    /// level goes as all three, and the task's own spelling of an untouched expression is left alone.
    func edit(from start: TaskDraft) -> TaskEdit {
        var edit = TaskEdit()
        if spaceId != start.spaceId { edit.spaceId = spaceId }
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if name != start.title { edit.title = name }
        if goal != start.goal { edit.goal = goal }
        if expression != start.expression { edit.cron = expression }
        if agentKind != start.agentKind || model != start.model || effort != start.effort {
            edit.agent = agentKind
            edit.model = model
            edit.effort = effort
        }
        if newSessionPerRun != start.newSessionPerRun { edit.newSessionPerRun = newSessionPerRun }
        if archiveSucceeded != start.archiveSucceeded { edit.archiveSucceeded = archiveSucceeded }
        return edit
    }

    /// What `teammate.checkIn` is sent for a check-in: all of it when new, and what changed otherwise.
    func checkIn(from start: TaskDraft?) -> CheckInEdit {
        guard let start else { return CheckInEdit(cron: expression, prompt: goal, enabled: true) }
        var edit = CheckInEdit()
        if expression != start.expression { edit.cron = expression }
        if goal != start.goal { edit.prompt = goal }
        return edit
    }
}

/// Schedule a task, and the same sheet to edit one, as the Mac's: a name, the instructions, when (repeat
/// or not, how often, what time) with the line that says when the first run would be, and how it runs
/// (the space, the agent and model or a teammate, a new session per run, archiving successes). The Mac
/// is asked when an expression next fires, since its clock is the one a repeating task runs on.
struct TaskSheet: View {
    let start: TaskSheetStart
    let spaces: [Space]
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft: TaskDraft
    private let opening: TaskDraft
    private let task: ScheduledTask?
    /// When the Mac says the expression fires next, and which expression it was asked of.
    @State private var read: (expression: String, next: Millis?)?
    @State private var saving = false
    @State private var failure: String?
    @State private var detent = PresentationDetent.large

    init(start: TaskSheetStart, spaces: [Space]) {
        self.start = start
        self.spaces = spaces
        switch start {
        case .new(let draft):
            task = nil
            opening = draft
            _draft = State(initialValue: draft)
        case .edit(let task):
            let draft = TaskDraft(task)
            self.task = task
            opening = draft
            _draft = State(initialValue: draft)
        }
    }

    private var kept: String? { task == nil ? nil : opening.expression }

    /// A single run's moment is the phone's own to judge; anything else, the Mac's.
    private var first: Millis? {
        if !draft.repeats {
            let at = draft.moment.timeIntervalSince1970 * 1000
            return at > Date.now.timeIntervalSince1970 * 1000 ? at : nil
        }
        return read?.expression == draft.expression ? read?.next : nil
    }

    /// Whether the line under When can be said yet: not while the Mac has not answered for this expression.
    private var answered: Bool { !draft.repeats || read?.expression == draft.expression }

    private var teammates: [Teammate] {
        let taken = Set((model.work.schedules ?? []).compactMap(\.teammateId))
        return (model.work.teammates ?? []).filter { $0.spaceId == draft.spaceId && !taken.contains($0.id) }
    }

    private var title: String {
        guard task != nil else { return draft.isCheckIn ? "Set a check-in" : "Schedule a task" }
        return draft.isCheckIn ? "Edit check-in" : "Edit task"
    }

    private var changed: Bool { draft != opening }

    var body: some View {
        NavigationStack {
            form
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", systemImage: "xmark") { dismiss() }
                    }
                    .sharedBackgroundVisibility(.hidden)
                    ToolbarItem(placement: .topBarTrailing) {
                        if saving {
                            ProgressView()
                        } else {
                            let ready = model.isConnected && draft.valid(first: first, kept: kept) && (task == nil || changed)
                            Button(task == nil ? "Create" : "Save", systemImage: "checkmark") { save() }
                                .foregroundStyle(ready ? Palette.ink : Palette.ink3)
                                .disabled(!ready)
                                .accessibilityIdentifier("task-save")
                        }
                    }
                    .sharedBackgroundVisibility(.hidden)
                }
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationBackground(Ground.grouped)
        .interactiveDismissDisabled(saving || changed)
        .task(id: draft.repeats ? draft.expression : "") { await askTheMac() }
        .task {
            await model.loadAgents()
            await model.work.loadTeam()
            if draft.agentKind == nil, !draft.isCheckIn { draft.agentKind = TaskDraft.defaultAgent(model.agentList) }
        }
    }

    private var form: some View {
        Form {
            words
            when
            runsOn
        }
        .scrollContentBackground(.hidden)
        .background(Ground.grouped)
        .softEdges(ground: Ground.grouped)
        .disabled(saving)
    }

    private var words: some View {
        Section {
            if !draft.isCheckIn {
                TextField("Task name", text: $draft.title)
                    .listRowBackground(Fill.card)
                    .accessibilityIdentifier("task-name")
            }
            TextField(draft.isCheckIn ? "What it is told" : "Instructions…", text: $draft.goal, axis: .vertical)
                .lineLimit(4...10)
                .listRowBackground(Fill.card)
                .accessibilityIdentifier("task-goal")
        } footer: {
            if let failure {
                Text(failure).foregroundStyle(Palette.orange)
            } else if draft.isCheckIn {
                Text("Its chat gets this message at these times, and it reports there.")
            }
        }
    }

    private var when: some View {
        Section {
            if !draft.isCheckIn {
                Toggle("Repeat task", isOn: $draft.repeats)
                    .tint(Palette.accent)
                    .listRowBackground(Fill.card)
                    .accessibilityIdentifier("task-repeat")
            }
            if draft.repeats {
                repeatRows
            } else {
                DatePicker("Date", selection: $draft.moment)
                    .listRowBackground(Fill.card)
                    .accessibilityIdentifier("task-moment")
            }
        } footer: {
            if answered {
                Text(draft.whenLine(first: first, kept: kept))
                    .foregroundStyle(first == nil && draft.expression != kept ? Palette.orange : Palette.ink2)
                    .accessibilityIdentifier("task-when-line")
            }
        }
    }

    @ViewBuilder
    private var repeatRows: some View {
        Picker("Repeat", selection: Binding(get: { draft.every }, set: { draft.choose($0) })) {
            ForEach(TaskEvery.allCases) { every in Text(every.label).tag(every) }
        }
        .listRowBackground(Fill.card)
        .accessibilityIdentifier("task-every")
        if draft.every == .weekly {
            Picker("Day", selection: $draft.weekday) {
                // Monday first, the way a week is read; the values stay cron's.
                ForEach([1, 2, 3, 4, 5, 6, 0], id: \.self) { day in Text(Calendar.current.weekdaySymbols[day]).tag(day) }
            }
            .listRowBackground(Fill.card)
        }
        if draft.every == .monthly {
            Picker("Day", selection: $draft.monthDay) {
                ForEach(1...31, id: \.self) { day in Text(day.formatted(.number)).tag(day) }
            }
            .listRowBackground(Fill.card)
        }
        if draft.every == .hourly {
            Picker("Minute", selection: $draft.pastHour) {
                ForEach(draft.minuteChoices, id: \.self) { minute in Text(":\(String(format: "%02d", minute))").tag(minute) }
            }
            .listRowBackground(Fill.card)
        }
        if draft.every == .custom {
            LabeledContent("Expression") {
                TextField("0 9 * * *", text: $draft.cron)
                    .mono(.body)
                    .multilineTextAlignment(.trailing)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .accessibilityIdentifier("task-cron")
            }
            .listRowBackground(Fill.card)
        }
        if draft.every != .hourly, draft.every != .custom {
            DatePicker("Time", selection: clock, displayedComponents: .hourAndMinute)
                .listRowBackground(Fill.card)
                .accessibilityIdentifier("task-time")
        }
    }

    /// The hour and minute a task names, on whatever day the picker is shown.
    private var clock: Binding<Date> {
        Binding(get: {
            Calendar.current.date(bySettingHour: draft.hour, minute: draft.minute, second: 0, of: .now) ?? .now
        }, set: { date in
            draft.hour = Calendar.current.component(.hour, from: date)
            draft.minute = Calendar.current.component(.minute, from: date)
        })
    }

    @ViewBuilder
    private var runsOn: some View {
        let agents = model.agentList.map(NewSessionDefaults.agents) ?? []
        let agent = agents.first { $0.kind == draft.agentKind }
        Section("Runs on") {
            if !draft.isCheckIn, !spaces.isEmpty {
                Picker("Space", selection: spaceChoice) {
                    ForEach(spaces) { space in Text(space.name).tag(space.id) }
                }
                .listRowBackground(Fill.card)
                .accessibilityIdentifier("task-space")
            }
            if task == nil {
                Picker("Agent", selection: targetChoice) {
                    ForEach(agents.filter(\.available), id: \.kind) { option in
                        Text(option.name).tag("agent:\(option.kind)")
                    }
                    if !teammates.isEmpty {
                        Section("Teammates") {
                            ForEach(teammates) { teammate in Text(teammate.name).tag("teammate:\(teammate.id)") }
                        }
                    }
                }
                .listRowBackground(Fill.card)
                .accessibilityIdentifier("task-agent")
            } else if !draft.isCheckIn, !agents.isEmpty {
                Picker("Agent", selection: targetChoice) {
                    ForEach(agents.filter { $0.available || $0.kind == draft.agentKind }, id: \.kind) { option in
                        Text(option.name).tag("agent:\(option.kind)")
                    }
                }
                .listRowBackground(Fill.card)
                .accessibilityIdentifier("task-agent")
            }
            if !draft.isCheckIn, let agent {
                Picker("Model", selection: modelChoice) {
                    ForEach(agent.models, id: \.id) { choice in Text(choice.label).tag(choice.id) }
                    if let model = draft.model, !agent.models.contains(where: { $0.id == model }) {
                        Text(model).tag(Optional(model))
                    }
                }
                .listRowBackground(Fill.card)
                let efforts = agent.models.first { $0.id == draft.model }?.efforts ?? agent.efforts
                if !efforts.isEmpty {
                    Picker("Reasoning", selection: $draft.effort) {
                        Text("Default").tag(String?.none)
                        ForEach(efforts) { choice in Text(choice.label).tag(Optional(choice.id)) }
                    }
                    .listRowBackground(Fill.card)
                }
            }
            if !draft.isCheckIn {
                LabeledContent("Permissions", value: "Full access")
                    .listRowBackground(Fill.card)
            }
        }
        if !draft.isCheckIn {
            Section {
                Toggle(isOn: $draft.newSessionPerRun) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Start each run in a new session")
                        if !draft.newSessionPerRun {
                            Text("Each run continues the last run’s session")
                                .font(.footnote)
                                .foregroundStyle(Palette.ink2)
                        }
                    }
                }
                .tint(Palette.accent)
                .listRowBackground(Fill.card)
                .accessibilityIdentifier("task-new-session")
                Toggle(isOn: $draft.archiveSucceeded) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Archive successful runs")
                        Text("Failed and interrupted runs stay visible")
                            .font(.footnote)
                            .foregroundStyle(Palette.ink2)
                    }
                }
                .tint(Palette.accent)
                .listRowBackground(Fill.card)
                .accessibilityIdentifier("task-archive")
            }
        }
    }

    /// A teammate belongs to its space, so another space lets go of one chosen in this one.
    private var spaceChoice: Binding<String> {
        Binding(get: { draft.spaceId }, set: { spaceId in
            draft.spaceId = spaceId
            if task == nil, draft.isCheckIn {
                draft.teammateId = nil
                draft.agentKind = TaskDraft.defaultAgent(model.agentList)
            }
        })
    }

    /// An agent starts on its own default model and level; a teammate runs on what it runs on, and only
    /// ever repeats, as its sheet on the Mac has it.
    private var targetChoice: Binding<String> {
        Binding(get: {
            draft.teammateId.map { "teammate:\($0)" } ?? "agent:\(draft.agentKind ?? "")"
        }, set: { choice in
            if choice.hasPrefix("teammate:") {
                draft.teammateId = String(choice.dropFirst("teammate:".count))
                draft.repeats = true
            } else {
                let kind = String(choice.dropFirst("agent:".count))
                draft.teammateId = nil
                if kind != draft.agentKind {
                    draft.agentKind = kind
                    draft.model = nil
                    draft.effort = nil
                }
            }
        })
    }

    /// A level set under another model is not what runs on this one.
    private var modelChoice: Binding<String?> {
        Binding(get: { draft.model }, set: { chosen in
            draft.model = chosen
            let agent = model.agentList?.agents.first { $0.kind == draft.agentKind }
            let levels = agent?.models.first { $0.id == chosen }?.efforts ?? agent?.efforts ?? []
            if let effort = draft.effort, !levels.contains(where: { $0.id == effort }) { draft.effort = nil }
        })
    }

    /// Rested a moment first, so a typed expression is one question to the Mac.
    private func askTheMac() async {
        guard draft.repeats, let api = model.api, model.isConnected else { return }
        let expression = draft.expression
        do {
            try await Task.sleep(for: .milliseconds(draft.every == .custom ? 250 : 0))
            let answer = try await api.taskWhen(cron: expression)
            read = (expression, answer.next)
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { failure = AppModel.describe(error) }
        }
    }

    private func save() {
        saving = true
        failure = nil
        Task {
            do {
                if let teammateId = draft.teammateId {
                    let edit = draft.checkIn(from: task == nil ? nil : opening)
                    if !edit.isEmpty { try await model.work.setCheckIn(teammateId: teammateId, edit) }
                } else if let task {
                    try await model.work.update(task.id, draft.edit(from: opening))
                } else if let new = draft.newTask() {
                    try await model.work.createTask(new)
                }
                dismiss()
            } catch ChannelError.rpc(let refusal) {
                failure = "\(task == nil ? "Not created" : "Not saved"): \(refusal.message)"
                saving = false
            } catch {
                failure = "\(task == nil ? "Not created" : "Not saved"): \(AppModel.describe(error))"
                saving = false
            }
        }
    }
}
