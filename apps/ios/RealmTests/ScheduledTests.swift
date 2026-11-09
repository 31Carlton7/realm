import Foundation
import RealmKit
import Testing

@testable import Realm

/// The Scheduled page's words and groups, and what its sheet holds and sends.
@MainActor
@Suite("Scheduled tasks on the phone")
struct ScheduledTests {
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }()
    static let english = Locale(identifier: "en_US")
    /// Wednesday, November 4 2026, noon.
    static let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 4, hour: 12))!
    static func at(days: Int, hour: Int) -> Millis {
        let day = calendar.date(byAdding: .day, value: days, to: now)!
        return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day)!.timeIntervalSince1970 * 1000
    }

    static func task(_ id: String, cadence: TaskCadence.Repeat = .daily, enabled: Bool = true, next: Millis? = nil, last: Millis? = nil, skipped: Millis? = nil,
                     space: String = "sp", teammate: String? = nil, goal: String = "Go", when: String = "Every day at 9:00 AM") -> ScheduledTask {
        ScheduledTask(id: id, spaceId: space, spaceName: "Realm", title: id, when: when, enabled: enabled, nextRunAt: next, lastRunAt: last, lastRun: nil,
                      goal: goal, cron: "0 9 * * *", cadence: TaskCadence(repeat: cadence), agentKind: teammate == nil ? "claude" : nil,
                      newSessionPerRun: true, archiveSucceeded: false, lastSkippedAt: skipped, teammateId: teammate)
    }

    private func line(_ task: ScheduledTask) -> String {
        ScheduleWords.line(task, now: Self.now, calendar: Self.calendar, locale: Self.english).replacingOccurrences(of: "\u{202F}", with: " ")
    }

    @Test func aRowSaysWhenItRunsNextAndHowOften() {
        #expect(line(Self.task("t", next: Self.at(days: 1, hour: 9))) == "Tomorrow 9:00 AM · Daily")
        #expect(line(Self.task("t", cadence: .weekdays, next: Self.at(days: 0, hour: 15))) == "Today 3:00 PM · Weekdays")
        #expect(line(Self.task("t", cadence: .weekly, next: Self.at(days: 2, hour: 16))) == "Friday 4:00 PM · Weekly")
        #expect(line(Self.task("t", cadence: .monthly, next: Self.at(days: 27, hour: 9))) == "Dec 1 · Monthly")
        #expect(line(Self.task("t", cadence: .hourly, next: Self.at(days: 0, hour: 13))) == "Today 1:00 PM · Hourly")
        #expect(line(Self.task("t", cadence: .custom, next: Self.at(days: 400, hour: 9))) == "Dec 9, 2027 · Custom")
        #expect(line(Self.task("t", enabled: false, next: Self.at(days: 1, hour: 9))) == "Paused · Daily")
        #expect(line(Self.task("t", cadence: .once, last: Self.at(days: -1, hour: 16))) == "Ran yesterday 4:00 PM · Once")
        #expect(line(Self.task("t", cadence: .once)) == "Finished · Once")
    }

    @Test func aMissedRunIsNamedUntilARealOneHappens() {
        let missed = ScheduleWords.missed(Self.task("t", last: 10, skipped: Self.at(days: -1, hour: 16)), now: Self.now, calendar: Self.calendar, locale: Self.english)
        #expect(missed?.replacingOccurrences(of: "\u{202F}", with: " ") == "Missed a run yesterday 4:00 PM")
        #expect(ScheduleWords.missed(Self.task("t", last: 20, skipped: 10), now: Self.now) == nil)
        #expect(ScheduleWords.missed(Self.task("t"), now: Self.now) == nil)
    }

    @Test func aTaskNamesWhatItRunsOn() {
        let opus = ModelChoice(id: "opus", label: "Opus 5.5")
        let claude = AgentOptions(kind: "claude", name: "Claude", mark: "claude", models: [ModelChoice(id: nil, label: "Default"), opus])
        let onDefault = Self.task("t")
        #expect(ScheduleWords.target(onDefault, agents: [claude], teammate: nil) == "Claude")
        let pinned = ScheduledTask(id: "t", spaceId: "s", spaceName: "", title: "t", when: "", enabled: true, nextRunAt: nil, lastRunAt: nil, lastRun: nil, agentKind: "claude", model: "opus")
        #expect(ScheduleWords.target(pinned, agents: [claude], teammate: nil) == "Claude · Opus 5.5")
        #expect(ScheduleWords.target(pinned, agents: [], teammate: nil) == "Claude · opus")
        #expect(ScheduleWords.target(Self.task("Mira", teammate: "m"), agents: [claude], teammate: nil) == "Mira's chat")
    }

    @Test func aFinishedOneShotHasNothingToPause() {
        #expect(ScheduleWords.finished(Self.task("t", cadence: .once, last: 5)))
        #expect(!ScheduleWords.finished(Self.task("t", cadence: .once, next: 5)))
        #expect(!ScheduleWords.finished(Self.task("t", cadence: .once, enabled: false)))
        #expect(!ScheduleWords.finished(Self.task("t", cadence: .daily, last: 5)))
    }

    @Test func aMacTooOldToChangeATaskOffersNoChange() {
        #expect(ScheduleWords.editable(Self.task("t")))
        #expect(!ScheduleWords.editable(ScheduledTask(id: "t", spaceId: "s", spaceName: "", title: "t", when: "", enabled: true, nextRunAt: nil, lastRunAt: nil, lastRun: nil)))
    }

    // MARK: The groups

    @Test func tasksGroupAsTheMacsPageDoesAndCheckInsStandApart() {
        let idea = SuggestedTask(title: "Watch CI", blurb: "b", goal: "g", cadence: TaskCadence(repeat: .daily))
        let taken = SuggestedTask(title: "brief", blurb: "b", goal: "g", cadence: TaskCadence(repeat: .daily))
        let tasks = [Self.task("brief", next: 5), Self.task("Mira", next: 6, teammate: "m"), Self.task("sweep", enabled: false)]
        let sections = TaskSections.arranged(tasks, suggested: [idea, taken], spaces: nil)
        #expect(sections.upcoming.map(\.id) == ["brief", "sweep"])
        #expect(sections.checkIns.map(\.id) == ["Mira"])
        // A suggestion taken up is a task now, under its own name in Upcoming.
        #expect(sections.suggested.map(\.title) == ["Watch CI"])
    }

    @Test func onlyTheProfileHomeShowsIsListed() {
        let tasks = [Self.task("mine", space: "a"), Self.task("theirs", space: "b")]
        #expect(TaskSections.arranged(tasks, suggested: [], spaces: ["a"]).upcoming.map(\.id) == ["mine"])
        #expect(TaskSections.arranged(tasks, suggested: [], spaces: nil).upcoming.count == 2)
    }

    @Test func aSearchReadsWhatATaskDoesAndHidesTheSuggestions() {
        let idea = SuggestedTask(title: "Watch CI", blurb: "b", goal: "g", cadence: TaskCadence(repeat: .daily))
        let tasks = [Self.task("Sweep", goal: "file my expenses"), Self.task("Brief", cadence: .weekly, when: "Fridays at 4:00 PM")]
        #expect(TaskSections.arranged(tasks, suggested: [idea], spaces: nil, query: " EXPENSES ").upcoming.map(\.id) == ["Sweep"])
        #expect(TaskSections.arranged(tasks, suggested: [idea], spaces: nil, query: "fridays").upcoming.map(\.id) == ["Brief"])
        #expect(TaskSections.arranged(tasks, suggested: [idea], spaces: nil, query: "weekly").upcoming.map(\.id) == ["Brief"])
        #expect(TaskSections.arranged(tasks, suggested: [idea], spaces: nil, query: "x").suggested.isEmpty)
    }

    // MARK: The sheet

    private func draft() -> TaskDraft {
        TaskDraft(spaceId: "sp", agentKind: "claude", now: Self.now, calendar: Self.calendar)
    }

    @Test func aNewTaskStartsEveryDayAtNineOrTomorrowAtNine() {
        var made = draft()
        #expect(made.expression == "0 9 * * *" && made.repeats)
        made.repeats = false
        #expect(made.moment.timeIntervalSince1970 * 1000 == Self.at(days: 1, hour: 9))
        #expect(made.expression == "once:\(Int64(Self.at(days: 1, hour: 9)))")
    }

    /// The expressions the Mac's Repeat rows write (`cronOf`).
    @Test func theRowsWriteTheMacsExpressions() {
        var made = draft()
        made.hour = 16
        made.minute = 30
        made.weekday = 5
        made.monthDay = 15
        made.pastHour = 45
        let written = TaskEvery.allCases.filter { $0 != .custom }.map { every -> String in
            made.every = every
            return made.expression
        }
        #expect(written == ["45 * * * *", "30 16 * * *", "30 16 * * 1-5", "30 16 * * 5", "30 16 15 * *"])
    }

    @Test func customOpensOnTheExpressionTheMenuWasWriting() {
        var made = draft()
        made.choose(.weekdays)
        made.choose(.custom)
        #expect(made.cron == "0 9 * * 1-5" && made.expression == "0 9 * * 1-5")
        made.cron = "  */5 * * * * "
        #expect(made.expression == "*/5 * * * *")
    }

    @Test func aSavedTaskOpensOnTheRowsThatWroteIt() {
        func opened(_ cadence: TaskCadence) -> TaskDraft {
            let task = ScheduledTask(id: "t", spaceId: "sp", spaceName: "", title: "T", when: "", enabled: true, nextRunAt: nil, lastRunAt: nil, lastRun: nil,
                                     goal: "  Go\n", cron: "@weird", cadence: cadence, agentKind: "codex", model: "m", effort: "high", newSessionPerRun: false, archiveSucceeded: true)
            return TaskDraft(task, now: Self.now, calendar: Self.calendar)
        }
        let weekly = opened(TaskCadence(repeat: .weekly, hour: 8, minute: 1, weekday: 2))
        #expect(weekly.every == .weekly && weekly.expression == "1 8 * * 2" && weekly.goal == "  Go\n")
        #expect(weekly.agentKind == "codex" && weekly.model == "m" && weekly.effort == "high" && !weekly.newSessionPerRun && weekly.archiveSucceeded)
        #expect(opened(TaskCadence(repeat: .monthly, hour: 9, minute: 0, day: 31)).expression == "0 9 31 * *")
        #expect(opened(TaskCadence(repeat: .hourly, minute: 7)).minuteChoices == [0, 7, 15, 30, 45])
        #expect(opened(TaskCadence(repeat: .custom)).expression == "@weird")
        let once = opened(TaskCadence(repeat: .once, at: 1_800_000_000_000))
        #expect(!once.repeats && once.expression == "once:1800000000000")
    }

    @Test func itsLineSaysWhenTheFirstRunWouldBeOrWhyThereIsNone() {
        var made = draft()
        func line(first: Millis?, kept: String? = nil) -> String {
            made.whenLine(first: first, kept: kept, now: Self.now, calendar: Self.calendar, locale: Self.english).replacingOccurrences(of: "\u{202F}", with: " ")
        }
        #expect(line(first: Self.at(days: 1, hour: 9)) == "First run tomorrow at 9:00 am.")
        #expect(line(first: nil) == "That expression will never run — check the five fields (minute, hour, day, month, weekday).")
        made.repeats = false
        #expect(line(first: Self.at(days: 1, hour: 9)) == "Runs once, tomorrow at 9:00 am.")
        #expect(line(first: nil) == "That time has already passed. Pick one ahead of now.")
        #expect(line(first: nil, kept: made.expression) == "Its time has passed. Pick a new one to run it again.")
        made.repeats = true
        made.teammateId = "m"
        #expect(line(first: Self.at(days: 1, hour: 9)) == "Next check-in tomorrow at 9:00 am.")
    }

    @Test func createWaitsForANameInstructionsAndAFirstRun() {
        var made = draft()
        #expect(!made.valid(first: 5, kept: nil))
        made.title = "  "
        made.goal = "Go"
        #expect(!made.valid(first: 5, kept: nil))
        made.title = "Brief"
        #expect(made.valid(first: 5, kept: nil))
        #expect(!made.valid(first: nil, kept: nil))
        // An edit that leaves When alone needs no first run: a finished one-shot can still be renamed.
        #expect(made.valid(first: nil, kept: made.expression))
        #expect(!made.valid(first: nil, kept: "1 2 3 4 5"))
        made.goal = " \n "
        #expect(!made.valid(first: 5, kept: nil))
        made.goal = "Go"
        made.agentKind = nil
        #expect(!made.valid(first: 5, kept: nil))
        // A check-in has no name of its own, runs on its teammate, and blank words are its usual words.
        var checkIn = draft()
        checkIn.teammateId = "m"
        checkIn.agentKind = nil
        #expect(checkIn.valid(first: 5, kept: nil))
    }

    @Test func aNewTaskGoesAsTypedAndAnEditSendsOnlyWhatChanged() {
        var made = draft()
        made.title = " Brief "
        made.goal = "  Go\n"
        made.model = "opus"
        let new = made.newTask()
        #expect(new?.title == "Brief" && new?.goal == "  Go\n" && new?.cron == "0 9 * * *" && new?.agent == "claude" && new?.model == "opus" && new?.newSessionPerRun == true)

        made.title = "Brief"
        made.goal = "Go"
        var after = made
        #expect(after.edit(from: made).isEmpty)
        after.hour = 10
        after.archiveSucceeded = true
        after.effort = "high"
        let edit = after.edit(from: made)
        #expect(edit.cron == "0 10 * * *" && edit.archiveSucceeded == true && edit.title == nil && edit.goal == nil)
        // The level goes with its agent and model, or an edit would put the task back on their defaults.
        #expect(edit.agent == "claude" && edit.model == "opus" && edit.effort == "high")
    }

    @Test func aCheckInSendsItsWholeSelfWhenNewAndItsChangesAfter() {
        var made = draft()
        made.teammateId = "m"
        made.goal = "How is it going?"
        #expect(made.checkIn(from: nil) == CheckInEdit(cron: "0 9 * * *", prompt: "How is it going?", enabled: true))
        let start = made
        #expect(made.checkIn(from: start).isEmpty)
        made.hour = 10
        #expect(made.checkIn(from: start) == CheckInEdit(cron: "0 10 * * *"))
    }

    @Test func deletingSaysWhatStays() {
        #expect(TaskActions.deleteTitle(Self.task("Brief")) == "Delete Brief?")
        #expect(TaskActions.deleteMessage(Self.task("Brief")) == "Its runs and their sessions stay.")
        #expect(TaskActions.deleteTitle(Self.task("Mira", teammate: "m")) == "Delete Mira's check-in?")
    }
}
