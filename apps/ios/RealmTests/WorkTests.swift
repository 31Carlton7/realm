import Foundation
import RealmKit
import Testing
@testable import Realm

/// The Mac's work beyond Home as the phone reads it: a lead session's sub-agents, the plans' limits
/// and the month's spend, Teams' reviews, and the scheduled tasks.
enum Work {
    /// Noon on Wednesday 14 October 2026 in UTC, the time zone the tests of days count in.
    static let now = Date(timeIntervalSince1970: 1_791_979_200)
    static var nowMillis: Millis { now.timeIntervalSince1970 * 1000 }
    static let minute: Millis = 60_000

    static func subagent(_ id: String = "child", status: SessionStatus = .idle, outcome: String? = nil, settled: Bool = true,
                         goal: String? = "Read the composer's code", report: String? = nil, startedAt: Millis? = nil,
                         note: String? = nil) -> Subagent {
        let started = startedAt ?? nowMillis - 10 * minute
        return Subagent(session: SessionRow(id: id, title: "Composer audit", spaceId: "sp", spaceName: "Realm", agent: "claude",
                                            model: "claude-opus-5-5", status: status, needsYou: false, unread: false,
                                            updatedAt: started + 4 * minute, modelLabel: "Opus 5.5"),
                        goal: goal, startedAt: started, settledAt: settled ? started + 3 * minute + 12_000 : nil, outcome: outcome,
                        report: report, note: note)
    }

    static func window(_ used: Double?, resetsIn minutes: Double?) -> PlanWindow {
        PlanWindow(id: "five_hour", label: "5-hour", usedPercent: used, resetsAt: minutes.map { nowMillis + $0 * minute })
    }

    static func review(_ id: String = "r1", state: String = "open", kind: String = "post", role: String? = "Writer",
                       to: String? = nil, channels: [String] = ["instagram"], items: Int = 2, updatedAt: Millis = 100) -> ReviewSummary {
        ReviewSummary(id: id, spaceId: "sp", spaceName: "Launch", roleName: role, title: "Captions for Tuesday", kind: kind, state: state,
                      itemCount: items, to: to, channels: channels, note: nil, sessionId: nil, updatedAt: updatedAt)
    }

    static func task(_ id: String, enabled: Bool = true, next: Millis? = nil, last: Millis? = nil,
                     run: ScheduledTask.LastRun? = nil) -> ScheduledTask {
        ScheduledTask(id: id, spaceId: "sp", spaceName: "Realm", title: id, when: "Weekdays at 9:00 AM", enabled: enabled,
                      nextRunAt: next, lastRunAt: last, lastRun: run)
    }

    static func run(_ state: String, unread: Bool = true) -> ScheduledTask.LastRun {
        ScheduledTask.LastRun(state: state, sessionId: "s1", unread: unread)
    }

    static let english = Locale(identifier: "en_US")

    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }
}

@MainActor
@Suite("A sub-agent's state")
struct SubagentStateTests {
    /// What its session is doing now outranks how its run ended: one sent a message after it finished
    /// is working again.
    @Test func itsSessionsLiveStatusComesFirst() {
        #expect(SubagentState(Work.subagent(status: .running, outcome: "done")) == .working)
        #expect(SubagentState(Work.subagent(status: .waiting, outcome: "failed")) == .waiting)
        #expect(SubagentState(Work.subagent(status: .waiting)).word == "Needs you")
    }

    @Test func howItsRunEndedIsSaidInTheMacsWords() {
        let ended: [(String, SubagentState, String)] = [
            ("done", .done, "Done"), ("failed", .failed, "Failed"), ("gone", .failed, "Failed"),
            ("timeout", .timedOut, "Timed out"), ("stopped", .stopped, "Stopped"),
            ("interrupted", .cancelled, "Cancelled"), ("cancelled", .cancelled, "Cancelled"),
        ]
        for (outcome, state, word) in ended {
            #expect(SubagentState(Work.subagent(outcome: outcome)) == state, "\(outcome)")
            #expect(SubagentState(Work.subagent(outcome: outcome)).word == word, "\(outcome)")
        }
        // An ending this phone has no word for is said in the Mac's.
        #expect(SubagentState(Work.subagent(outcome: "paused")).word == "Paused")
    }

    /// With no ending recorded: one whose run is under way works; one that left a report finished; one
    /// that errored or ended without a word failed; the rest were stopped.
    @Test func withNoEndingRecordedItIsReadOffItsSessionAndItsReport() {
        #expect(SubagentState(Work.subagent(settled: false)) == .working)
        #expect(SubagentState(Work.subagent(report: "All done")) == .done)
        #expect(SubagentState(Work.subagent(status: .error)) == .failed)
        #expect(SubagentState(Work.subagent(status: .ended)) == .failed)
        #expect(SubagentState(Work.subagent()) == .stopped)
    }

    /// Every state is a glyph and a word; colour is never the only thing that says it.
    @Test func everyStateHasAGlyphAndAWord() {
        let states: [SubagentState] = [.working, .waiting, .done, .failed, .timedOut, .stopped, .cancelled, .other("paused")]
        for state in states {
            #expect(!state.word.isEmpty && !state.symbol.isEmpty, "\(state)")
        }
        #expect(Set(states.map(\.word)).count == states.count, "two states say the same word")
        #expect(states.filter(\.isLive) == [.working, .waiting])
        #expect(SubagentState.done.tone == .done && SubagentState.failed.tone == .failed && SubagentState.timedOut.tone == .failed)
        #expect(SubagentState.working.tone == .working && SubagentState.waiting.tone == .waiting && SubagentState.stopped.tone == .quiet)
    }
}

@MainActor
@Suite("What the sub-agents' control and sheet say")
struct SubagentWordsTests {
    /// The bar counts them, with the working mark while one is still going; a session that started
    /// none shows nothing there.
    @Test func theControlCountsThemAndMarksOneWorking() {
        #expect(SubagentsControlLabel([]) == nil)
        let settled = SubagentsControlLabel([Work.subagent("a", outcome: "done")])
        #expect(settled?.words == "1 sub-agent" && settled?.working == false)
        let going = SubagentsControlLabel([Work.subagent("a", outcome: "done"), Work.subagent("b", status: .waiting)])
        #expect(going?.words == "2 sub-agents" && going?.working == true)
        #expect(SubagentsControlLabel([Work.subagent("a", settled: false)])?.working == true)
    }

    @Test func theSheetSaysWhereTheyAllStandWhatNeedsYouFirst() {
        #expect(SubagentWords.rollup([.done, .working, .waiting, .failed, .timedOut, .cancelled, .working])
                == "1 needs you · 2 working · 1 done · 2 failed · 1 stopped")
        #expect(SubagentWords.rollup([.waiting, .waiting]) == "2 need you")
        #expect(SubagentWords.rollup([.working, .done], separator: ", ") == "1 working, 1 done")
        #expect(SubagentWords.rollup([.other("paused")]) == "1 stopped")
        #expect(SubagentWords.rollup([]) == "")
    }

    @Test func newestFirstAndTiesKeepTheMacsOrder() {
        let older = Work.subagent("older", startedAt: 100), newer = Work.subagent("newer", startedAt: 300)
        let twinA = Work.subagent("a", startedAt: 200), twinB = Work.subagent("b", startedAt: 200)
        #expect(SubagentOrder.newestFirst([older, twinA, newer, twinB]).map(\.id) == ["newer", "a", "b", "older"])
    }

    /// The goal as one run of words a row folds, or the session's title where it was given none.
    @Test func aRowLeadsWithItsGoal() {
        #expect(SubagentWords.goal(Work.subagent(goal: "Read the composer.\n\n  Then list   its views.")) == "Read the composer. Then list its views.")
        #expect(SubagentWords.goal(Work.subagent(goal: nil)) == "Composer audit")
        #expect(SubagentWords.goal(Work.subagent(goal: "  \n ")) == "Composer audit")
    }

    /// Settled, how long its run took; still going, how long so far, counting up; never below nothing.
    @Test func howLongItRan() {
        let settled = Work.subagent(outcome: "done")
        #expect(SubagentWords.ran(settled, state: .done, now: Work.now) == 192)
        let working = Work.subagent(status: .running, settled: false)
        #expect(SubagentWords.ran(working, state: .working, now: Work.now) == 600)
        // A run that kept no settling time ran until its session last changed.
        let unrecorded = Work.subagent(settled: false, report: "Done")
        #expect(SubagentWords.ran(unrecorded, state: .done, now: Work.now) == 240)
        let ahead = Work.subagent(status: .running, settled: false, startedAt: Work.nowMillis + 5_000)
        #expect(SubagentWords.ran(ahead, state: .working, now: Work.now) == 0)
        #expect(PillWords.elapsed(192) == "3m 12s")
    }

    /// A report folds to plain prose: no headings, fences, emphasis, list marks or link targets.
    @Test func aReportIsFoldedToPlainProse() {
        let report = """
        ## What I found

        The composer draws **three** toolbars:
        - `ComposerView` at the foot
        - the [settings sheet](https://realm.computer/x)

        ```swift
        let x = 1
        ```
        > Nothing else.
        """
        #expect(SubagentWords.report(Work.subagent(report: report))
                == "What I found The composer draws three toolbars: ComposerView at the foot the settings sheet Nothing else.")
        #expect(SubagentWords.report(Work.subagent(report: nil)) == nil)
        #expect(SubagentWords.report(Work.subagent(report: "```\ncode only\n```")) == nil)
    }

    @Test func aRowIsSpokenWhole() {
        let child = Work.subagent(outcome: "done", report: "**Three** toolbars.")
        #expect(SubagentWords.spoken(child, now: Work.now)
                == "Read the composer's code, Done, 3 minutes, 12 seconds, Opus 5.5, Three toolbars.")
    }
}

@MainActor
@Suite("Usage's words")
struct UsageWordsTests {
    @Test func aCountdownReadsAsTheMacWritesIt() {
        #expect(Countdown.text(30) == "under a minute")
        #expect(Countdown.text(12 * 60 + 59) == "12m")
        #expect(Countdown.text(3_600) == "1h")
        #expect(Countdown.text(2 * 3_600 + 10 * 60) == "2h 10m")
        #expect(Countdown.text(3 * 86_400) == "3d")
        #expect(Countdown.text(3 * 86_400 + 4 * 3_600 + 59 * 60) == "3d 4h")
        #expect(Countdown.text(2 * 3_600 + 60, spoken: true) == "2 hours 1 minute")
        #expect(Countdown.text(86_400 + 3_600, spoken: true) == "1 day 1 hour")
    }

    @Test func aWindowSaysHowMuchIsUsedAndWhenItResets() {
        let reading = WindowReading(Work.window(61.6, resetsIn: 130), now: Work.now)
        #expect(reading.words == "62% used · resets in 2h 10m")
        #expect(reading.fraction == 0.62)
        #expect(reading.spoken == "62 percent used, resets in 2 hours 10 minutes")
        #expect(WindowReading(Work.window(40, resetsIn: nil), now: Work.now).words == "40% used")
        // A figure past the ends is drawn at them.
        #expect(WindowReading(Work.window(140, resetsIn: 5), now: Work.now).fraction == 1)
        #expect(WindowReading(Work.window(-3, resetsIn: 5), now: Work.now).words == "0% used · resets in 5m")
    }

    /// Neither a window with no figure nor one that reset since its reading is drawn as a bar: an empty
    /// one would read as plenty left, and an old figure as usage the new window does not have.
    @Test func aWindowWithNoFigureOrThatHasResetGetsNoBar() {
        let unreported = WindowReading(Work.window(nil, resetsIn: 30), now: Work.now)
        #expect(unreported.fraction == nil)
        #expect(unreported.words == "Not reported · resets in 30m")
        let reset = WindowReading(Work.window(90, resetsIn: -1), now: Work.now)
        #expect(reset.fraction == nil)
        #expect(reset.words == "Reset since this reading")
        #expect(WindowReading(Work.window(90, resetsIn: 0), now: Work.now).fraction == nil)
    }

    @Test func aPlanIsNamedAsAPersonSaysIt() {
        let plan = { (tier: String?) in
            PlanLimits(agent: "claude", agentName: "Claude", agentMark: "claude", plan: tier, windows: [], alert: nil, unavailable: nil, at: 0)
        }
        #expect(PlanWords.title(plan("max")) == "Claude Max")
        #expect(PlanWords.title(plan("enterprise")) == "Claude Enterprise")
        #expect(PlanWords.title(plan(nil)) == "Claude")
        #expect(PlanWords.title(plan(" ")) == "Claude")
    }

    @Test func anOldReadingSaysHowOld() {
        #expect(PlanWords.age(Work.nowMillis - 60_000, now: Work.now) == nil)
        #expect(PlanWords.age(Work.nowMillis - 12 * Work.minute, now: Work.now) == "As of 12m ago")
        #expect(PlanWords.age(0, now: Work.now) == nil)
    }

    @Test func dollarsReadAsTheMacWritesThem() {
        #expect(Money.text(0, locale: Work.english) == "$0.00")
        #expect(Money.text(0.0042, locale: Work.english) == "$0.0042")
        #expect(Money.text(12.34, locale: Work.english) == "$12.34")
        #expect(Money.text(1_234.5, locale: Work.english) == "$1,234.50")
    }

    /// Against a budget, a bar and how far into it, coloured as the Mac's budget meter is, near its end
    /// and over it; without one, the sum alone.
    @Test func theMonthsSpendIsReadAgainstItsBudget() {
        let spend = { (spent: Double, budget: Double?) in SpendReading(Spend(monthToDate: spent, budget: budget, topSessions: []), locale: Work.english) }
        let none = spend(12.34, nil)
        #expect(none.total == "$12.34" && none.fraction == nil && none.level == nil)
        #expect(none.words == "No budget is set on your Mac.")
        let quarter = spend(12.5, 50)
        #expect(quarter.fraction == 0.25 && quarter.level == .within)
        #expect(quarter.words == "25% of the $50.00 budget")
        #expect(spend(40, 50).level == .near)
        #expect(spend(39.9, 50).level == .within)
        let full = spend(50, 50)
        #expect(full.level == .over && full.words == "100% of the $50.00 budget")
        let over = spend(53.2, 50)
        #expect(over.fraction == 1 && over.level == .over)
        #expect(over.words == "Over the $50.00 budget by $3.20")
        #expect(spend(5, 0).fraction == nil, "a budget of nothing is none")
    }
}

@MainActor
@Suite("Review's words")
struct ReviewWordsTests {
    @Test func aReviewWaitsForTheMacOrIsSentBackOrDecided() {
        #expect(ReviewStage("open") == .waiting && ReviewStage("waiting") == .waiting)
        #expect(ReviewStage("changes") == .changes)
        #expect(ReviewStage("approved") == .approved)
        #expect(ReviewStage("rejected") == .decided("rejected"))
        #expect(ReviewStage("open").words == nil)
        #expect(ReviewStage("changes").words == "Changes asked for · waiting for a new version")
        #expect(ReviewStage("approved").words == "Approved · finish it on your Mac")
        #expect(ReviewStage("rejected").words == "Rejected")
        // Only a review waiting for the person is decided here.
        #expect(["open", "waiting", "changes", "approved", "rejected"].map { ReviewStage($0).offersDecision } == [true, true, false, false, false])
    }

    @Test func newestFirstAndTiesKeepTheMacsOrder() {
        let reviews = [Work.review("a", updatedAt: 1), Work.review("b", updatedAt: 3), Work.review("c", updatedAt: 2), Work.review("d", updatedAt: 3)]
        #expect(ReviewOrder.newestFirst(reviews).map(\.id) == ["b", "d", "c", "a"])
    }

    /// The role and space, then who it goes to or where, and how many items it holds.
    @Test func aRowSaysWhoHandedItBackAndWhereItGoes() {
        #expect(ReviewWords.about(Work.review()) == "Writer · Launch")
        #expect(ReviewWords.about(Work.review(role: nil)) == "Launch")
        #expect(ReviewWords.reach(Work.review()) == "On Instagram · 2 items")
        #expect(ReviewWords.reach(Work.review(to: "@reader")) == "To @reader on Instagram · 2 items")
        #expect(ReviewWords.reach(Work.review(kind: "message", to: "dana@acme.com", channels: ["email"], items: 1)) == "To dana@acme.com · 1 item")
        #expect(ReviewWords.reach(Work.review(channels: ["instagram", "TikTok"])) == "On Instagram and TikTok · 2 items")
        #expect(ReviewWords.reach(Work.review(kind: "document", channels: [], items: 3)) == "3 items")
    }

    @Test func anItemSaysItsPlaceItsChannelAndWhoItGoesTo() {
        let item = ReviewDetail.Item(id: "i2", title: nil, body: "Hi", channel: "instagram", to: "@reader", files: [])
        #expect(ReviewWords.item(item, at: 1, of: 3) == "Item 2 of 3 · Instagram · to @reader")
        #expect(ReviewWords.item(item, at: 0, of: 1) == "Instagram · to @reader")
        let bare = ReviewDetail.Item(id: "i1", title: nil, body: "Hi", channel: nil, to: "", files: [])
        #expect(ReviewWords.item(bare, at: 0, of: 1) == "")
    }

    /// Before Approve is pressed, the dock says that approving sends nothing by itself: what goes out
    /// is still pressed on the Mac.
    @Test func approvingSaysItSendsNothingByItself() {
        for review in [Work.review(kind: "post"), Work.review(kind: "message"), Work.review(kind: "document")] {
            let words = ReviewWords.approving(review)
            #expect(words.contains("nothing by itself") && words.hasSuffix("on your Mac."), "\(review.kind)")
        }
        #expect(ReviewWords.approving(Work.review(kind: "slideshows")) == "Approving posts nothing by itself: you still press Post on your Mac.")
        #expect(ReviewWords.approving(Work.review(kind: "message")) == "Approving sends nothing by itself: you still press Send on your Mac.")
    }

    @Test func aDecisionSaysWhatItLeft() {
        #expect(ReviewWords.receipt(.approve, Work.review(kind: "post")) == "Approved. It posts when you press Post on your Mac.")
        #expect(ReviewWords.receipt(.approve, Work.review(kind: "report")) == "Approved. Nothing goes out until it is pressed on your Mac.")
        #expect(ReviewWords.receipt(.changes, Work.review()) == "Asked Writer for changes.")
        #expect(ReviewWords.receipt(.changes, Work.review(role: nil)) == "Asked the role for changes.")
        #expect(ReviewWords.receipt(.reject, Work.review()) == "Rejected. Nothing of it goes out.")
        #expect([ReviewDecision.approve, .changes, .reject].map(ReviewWords.refused) == ["Not approved.", "Not sent.", "Not rejected."])
    }

    /// Asking for changes needs a note, which goes trimmed; a rejection may go without a reason.
    @Test func askingForChangesNeedsANoteAndRejectingDoesNot() {
        let changes = DecisionNote(.changes, for: Work.review())
        #expect(changes.title == "Ask for changes" && changes.prompt == "What should Writer change?" && changes.confirm == "Send")
        #expect(!changes.canSend("") && !changes.canSend("  \n"))
        #expect(changes.canSend("Shorter"))
        #expect(changes.note("  Shorter, please \n") == "Shorter, please")
        let reject = DecisionNote(.reject, for: Work.review())
        #expect(reject.title == "Reject" && reject.confirm == "Reject")
        #expect(reject.canSend(""))
        #expect(reject.note(" ") == nil)
        #expect(reject.footer == "Nothing of it goes out, and it can't be sent again.")
    }

    @Test func aRowIsSpokenWhole() {
        let spoken = ReviewWords.spoken(Work.review(state: "changes", updatedAt: Work.nowMillis - 5 * Work.minute), now: Work.now)
        #expect(spoken == "Captions for Tuesday, Writer, Launch, On Instagram, 2 items, Changes asked for, waiting for a new version, 5m ago")
    }
}

@MainActor
@Suite("Scheduled's words")
struct ScheduledWordsTests {
    @Test func aRunsStateIsReadInTheMacsWordsOrItsOwn() {
        let states: [(String, RunState)] = [
            ("Starting", .starting), ("queued", .starting), ("Running", .running), ("running", .running),
            ("Needs you", .needsYou), ("blocked", .needsYou), ("Finished", .finished), ("succeeded", .finished),
            ("Failed", .failed), ("Expired", .expired), ("Stopped", .stopped), ("cancelled", .stopped),
        ]
        for (word, state) in states { #expect(RunState(word) == state, "\(word)") }
        #expect(RunState("Snoozed") == .other("Snoozed"))
        #expect(RunState("snoozed").word == "Snoozed")
        let all: [RunState] = [.starting, .running, .needsYou, .finished, .failed, .expired, .stopped, .other("x")]
        #expect(all.filter(\.isFinished) == [.finished, .failed, .expired, .stopped])
        #expect(Set(all.map(\.word)).count == all.count)
        #expect(RunState.running.tone == .working && RunState.needsYou.tone == .waiting && RunState.failed.tone == .failed)
    }

    /// Home counts the runs that finished and were not read; one still going is no result yet.
    @Test func unreadResultsAreFinishedRunsNotRead() {
        let tasks = [
            Work.task("done", run: Work.run("Finished")), Work.task("failed", run: Work.run("Failed")),
            Work.task("read", run: Work.run("Finished", unread: false)), Work.task("running", run: Work.run("Running")),
            Work.task("never"),
        ]
        #expect(ScheduleWords.unreadResults(tasks) == 2)
        #expect(ScheduleWords.results(1) == "1 scheduled result")
        #expect(ScheduleWords.results(2) == "2 scheduled results")
    }

    /// What runs soonest first; then what is paused or will not run again, the latest run first.
    @Test func whatRunsSoonestComesFirst() {
        let tasks = [
            Work.task("paused", enabled: false, next: 50, last: 40), Work.task("later", next: 300), Work.task("once", last: 90),
            Work.task("soon", next: 100), Work.task("never"), Work.task("paused-older", enabled: false, last: 10),
        ]
        #expect(TaskOrder.nextFirst(tasks).map(\.id) == ["soon", "later", "once", "paused", "paused-older", "never"])
    }

    @Test func aMomentIsSaidAsAPersonAsksAfterOne() {
        let at = { (days: Double, hours: Double) in Work.nowMillis + days * 86_400_000 + hours * 3_600_000 }
        let when = { (millis: Millis) in ScheduleWords.when(millis, now: Work.now, calendar: Work.calendar, locale: Work.english) }
        #expect(when(at(0, -3)).hasPrefix("Today at 9:00"))
        #expect(when(at(1, -3)).hasPrefix("Tomorrow at 9:00"))
        #expect(when(at(-1, 0)).hasPrefix("Yesterday at 12:00"))
        #expect(when(at(3, 0)).hasPrefix("\(Date(timeIntervalSince1970: at(3, 0) / 1000).formatted(Date.FormatStyle(locale: Work.english, calendar: Work.calendar, timeZone: Work.calendar.timeZone).weekday(.wide))) at "))
        #expect(when(at(9, 0)).hasPrefix("\(Date(timeIntervalSince1970: at(9, 0) / 1000).formatted(Date.FormatStyle(locale: Work.english, calendar: Work.calendar, timeZone: Work.calendar.timeZone).month(.abbreviated).day())) at "))
    }

    /// Inside a sentence only the relative words and the meridiem are lowered: a weekday and a month
    /// are proper nouns.
    @Test func theNextRunIsSaidInASentence() {
        let next = { (task: ScheduledTask) in ScheduleWords.next(task, now: Work.now, calendar: Work.calendar, locale: Work.english) }
        let tomorrow = next(Work.task("t", next: Work.nowMillis + 86_400_000 - 3 * 3_600_000))
        #expect(tomorrow.hasPrefix("Next tomorrow at 9:00") && tomorrow.hasSuffix("am"))
        let weekday = next(Work.task("t", next: Work.nowMillis + 3 * 86_400_000))
        #expect(weekday.hasPrefix("Next ") && weekday.dropFirst(5).first?.isUppercase == true && weekday.hasSuffix("pm"))
        #expect(next(Work.task("t", enabled: false, next: Work.nowMillis + 60_000)) == "Paused")
        #expect(next(Work.task("t", last: Work.nowMillis - 86_400_000)).hasPrefix("Ran yesterday at 12:00"))
        #expect(next(Work.task("t")) == "Finished")
    }
}

@MainActor
@Suite("Home's head and its menu")
struct WorkHeadTests {
    @Test func nothingWaitingSaysNothing() {
        #expect(WorkHead.lines(reviews: nil, schedules: nil).isEmpty)
        #expect(WorkHead.lines(reviews: [], schedules: [Work.task("read", run: Work.run("Finished", unread: false))]).isEmpty)
        // A review sent back for changes waits on its role, not on the person.
        #expect(WorkHead.lines(reviews: [Work.review(state: "changes")], schedules: nil).isEmpty)
        // A search lists only what matched.
        #expect(WorkHead.lines(reviews: [Work.review()], schedules: [Work.task("t", run: Work.run("Finished"))], searching: true).isEmpty)
    }

    /// One quiet line for what waits in Review and one for the scheduled results not read, in that order.
    @Test func whatWaitsIsOneLineEach() {
        let reviews = [Work.review("a"), Work.review("b", state: "waiting"), Work.review("c", state: "changes")]
        let tasks = [Work.task("t", run: Work.run("Finished")), Work.task("u", run: Work.run("Running"))]
        let lines = WorkHead.lines(reviews: reviews, schedules: tasks)
        #expect(lines.map(\.words) == ["2 to review", "1 scheduled result"])
        #expect(lines.map(\.page) == [.reviews, .scheduled])
        #expect(lines.map(\.page.route) == [.reviews, .scheduled])
        #expect(WorkHead.lines(reviews: nil, schedules: tasks + [Work.task("v", run: Work.run("Failed"))]).map(\.words) == ["2 scheduled results"])
    }

    /// The bar's menu: Review, Scheduled and Usage, each a page of its own, Review and Scheduled with
    /// what waits there under their names.
    @Test func theMenuOffersThePagesAndWhatWaitsInThem() {
        #expect(WorkPage.allCases.map(\.title) == ["Review", "Scheduled", "Usage"])
        #expect(WorkPage.allCases.map(\.route) == [.reviews, .scheduled, .usage])
        let reviews = [Work.review("a"), Work.review("b")]
        let tasks = [Work.task("t", run: Work.run("Finished")), Work.task("u", run: Work.run("Expired"))]
        #expect(WorkPage.reviews.note(reviews: reviews, schedules: tasks) == "2 to review")
        #expect(WorkPage.scheduled.note(reviews: reviews, schedules: tasks) == "2 unread results")
        #expect(WorkPage.scheduled.note(reviews: nil, schedules: [tasks[0]]) == "1 unread result")
        #expect(WorkPage.usage.note(reviews: reviews, schedules: tasks) == nil)
        #expect(WorkPage.reviews.note(reviews: [], schedules: nil) == nil)
    }
}

/// The pages' words over the Mac's own answers (`packages/remote/test/fixtures/ts-api.json`, which the
/// server's suite writes): every state the Mac says is one the phone has a word and a glyph for, so a
/// word the Mac changes shows up here rather than as a blank or a guess on the phone.
@MainActor
@Suite("The pages read the Mac's own answers")
struct WorkFixtureWordsTests {
    nonisolated static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appending(path: "packages/remote/test/fixtures/ts-api.json")
    nonisolated static let available = FileManager.default.fileExists(atPath: fixture.path)

    static func call<T: Decodable>(_ type: T.Type, _ key: String) throws -> T {
        let calls = try #require((try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])?["calls"] as? [String: Any])
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: try #require(calls[key])))
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func everySubagentsStateIsOneThePhoneSays() throws {
        struct Answer: Decodable { let subagents: [Subagent] }
        let states = try Self.call(Answer.self, "session.subagents").subagents.map(SubagentState.init)
        #expect(states == [.working, .done, .cancelled])
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func everyReviewsStageIsOneThePhoneActsOn() throws {
        struct List: Decodable { let reviews: [ReviewSummary] }
        struct Decided: Decodable { let review: ReviewSummary }
        let reviews = try Self.call(List.self, "reviews.list").reviews
        #expect(reviews.map { ReviewStage($0.state) } == [.changes, .waiting])
        #expect(ReviewStage(try Self.call(Decided.self, "review.decide").review.state) == .approved)
        #expect(ReviewStage(try Self.call(Decided.self, "review.decide:changes").review.state) == .changes)
        // Only the one waiting for a decision is counted at Home's head.
        #expect(WorkHead.lines(reviews: reviews, schedules: nil).map(\.words) == ["1 to review"])
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func everyRunsStateIsOneThePhoneSays() throws {
        struct List: Decodable { let tasks: [ScheduledTask] }
        let tasks = try Self.call(List.self, "schedules.list").tasks
        #expect(tasks.compactMap(\.lastRun).map { RunState($0.state) } == [.finished, .failed])
        #expect(RunState(try #require(Self.call([String: ScheduledTask].self, "schedules.runNow")["task"]?.lastRun).state) == .starting)
        // The brief finished unread; the failed run was read.
        #expect(WorkHead.lines(reviews: nil, schedules: tasks).map(\.words) == ["1 scheduled result"])
    }

    /// The plan's windows as the page draws them at the reading's own moment: a bar for each with a
    /// figure, none for the one reset since and the one never measured.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aPlansWindowsAreDrawnOnlyWhereTheyHaveAFigure() throws {
        let claude = try #require(try Self.call(Usage.self, "usage.get").limits.first)
        let at = Date(timeIntervalSince1970: claude.at / 1000)
        #expect(claude.windows.map { WindowReading($0, now: at).fraction } == [0.91, nil, 0.34, nil])
        #expect(WindowReading(claude.windows[1], now: at).words == "Reset since this reading")
        #expect(WindowReading(claude.windows[3], now: at).words == "Not reported")
        #expect(PlanWords.title(claude) == "Claude Max")
    }
}
