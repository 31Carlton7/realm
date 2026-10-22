import Foundation
@testable import RealmKit
import Testing

/// The phone's pages beyond Home as the Mac writes them (`packages/remote/test/fixtures/ts-api.json`):
/// a lead's sub-agents, the plans' limits and the month's spend, Teams' open reviews, a review and
/// what deciding it answers, and the scheduled tasks; and the two events that say they changed.
@Suite("Sub-agents, Usage, Review and Scheduled as the Mac writes them")
struct WorkFixtureTests {
    static let available = APIFixtureTests.available

    static func decode<T: Decodable>(_ type: T.Type, _ key: String) throws -> T { try APIFixtureTests.decode(T.self, "calls", key) }

    static func event(_ name: String) throws -> [MobileEvent] {
        let payloads = try JSONSerialization.jsonObject(with: APIFixtureTests.part(["events", name])) as? [Any] ?? []
        return try payloads.map { payload in
            guard case .event(let event) = Envelope.classify(try JSONSerialization.data(withJSONObject: ["event": name, "payload": payload])) else {
                throw CocoaError(.coderReadCorrupt)
            }
            return event
        }
    }

    /// Newest first: one still working, with neither an end nor an ending; one done, with its report; one
    /// Realm stopped itself, saying why. Each carries its own session's row, model and all.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aLeadsSubagentsSayHowTheirWorkWent() throws {
        struct Answer: Decodable { let subagents: [Subagent] }
        let subagents = try Self.decode(Answer.self, "session.subagents").subagents
        #expect(subagents.map(\.startedAt) == subagents.map(\.startedAt).sorted(by: >))
        let working = try #require(subagents.first)
        #expect(working.session.status == .running && working.settledAt == nil && working.outcome == nil)
        #expect(working.goal?.hasPrefix("Backfill the theme column") == true)
        #expect(working.session.modelLabel == "GPT-6 Luna" && working.session.agentMark == "openai")
        let done = subagents[1]
        #expect(done.outcome == "done" && done.settledAt != nil && done.report?.contains("0042_theme.sql") == true)
        let stopped = subagents[2]
        #expect(stopped.outcome == "cancelled" && stopped.report == nil)
        #expect(stopped.note == "Stopped when the session that started it was stopped.")
        #expect(subagents.allSatisfy { subagent in subagent.settledAt.map { $0 >= subagent.startedAt } ?? true })
    }

    /// Each runnable agent's plan, the ones that report first: windows fullest first, one that reset
    /// since its reading and one never measured with no figure, the provider's warning in words; then
    /// the agents that cannot say, each with why. And the month's spend against its budget.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func usageCarriesEachPlanAndTheMonthsSpend() throws {
        let usage = try Self.decode(Usage.self, "usage.get")
        let claude = try #require(usage.limits.first)
        #expect(claude.agentName == "Claude" && claude.plan == "max")
        #expect(claude.windows.map(\.label) == ["Weekly", "Opus weekly", "5-hour", "Fable weekly"])
        #expect(claude.windows.map(\.usedPercent) == [91, nil, 34, nil])
        #expect(claude.windows[1].resetsAt.map { $0 < claude.at } == true, "a window that reset since its reading has no figure")
        #expect(claude.alert == "Weekly limit nearly reached")
        #expect(claude.unavailable == nil)
        let silent = usage.limits.dropFirst()
        #expect(silent.allSatisfy { $0.windows.isEmpty && $0.unavailable != nil && $0.alert == nil })
        #expect(silent.first?.unavailable == "Run a Codex session and its plan limits will appear here.")
        #expect(silent.contains { $0.unavailable == "Gemini does not report plan limits." })
        #expect(usage.spend.monthToDate == 61.38 && usage.spend.budget == 150)
        let costs = usage.spend.topSessions.map(\.cost)
        #expect(costs == costs.sorted(by: >) && costs.count == 5)
        #expect(usage.spend.topSessions.first?.title == "Theme column")
    }

    /// The reviews still open, newest first: one sent back with the person's note, one waiting with its
    /// channels; who each goes to, and the role's session.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theOpenReviewsAreNewestFirst() throws {
        struct Answer: Decodable { let reviews: [ReviewSummary] }
        let reviews = try Self.decode(Answer.self, "reviews.list").reviews
        #expect(reviews.map(\.updatedAt) == reviews.map(\.updatedAt).sorted(by: >))
        #expect(reviews.map(\.state) == ["changes", "waiting"])
        #expect(reviews[0].to == "dana@acme.com" && reviews[0].note == "Shorter, and say when it ships")
        #expect(reviews[1].roleName == "Content Producer" && reviews[1].spaceName == "Deck")
        #expect(reviews[1].itemCount == 2 && reviews[1].channels == ["instagram", "email"])
        #expect(reviews.allSatisfy { $0.sessionId != nil })
    }

    /// A review's items, in their order: a caption with its picture, by the path `review.file` takes;
    /// an email with its subject for a title and who it goes to.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aReviewsItemsCarryTheirDraftsAndPictures() throws {
        let detail = try Self.decode(ReviewDetail.self, "review.get")
        #expect(detail.review.itemCount == detail.items.count)
        let post = try #require(detail.items.first)
        #expect(post.channel == "instagram" && post.to == nil && post.title == nil)
        #expect(post.files == [SentFile(path: "/Users/me/Desktop/Deck/renders/toggle.png", name: "toggle.png", mime: "image/png")])
        let email = detail.items[1]
        #expect(email.title == "Dark mode ships Friday" && email.to == "dana@acme.com")
        #expect(email.body.hasPrefix("Hi Dana,") && email.files.isEmpty)
        let picture = try Self.decode(FilePreview.self, "review.file")
        #expect(picture.path == post.files[0].path && picture.name == "toggle.png")
        guard case .image(let mime, _) = picture.preview else {
            Issue.record("review.file is not a picture")
            return
        }
        #expect(mime == "image/jpeg")
    }

    /// What deciding answers: the review as it is now — approved, or sent back with the note.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aDecisionAnswersWithTheReviewAsItIsNow() throws {
        struct Answer: Decodable { let review: ReviewSummary }
        let approved = try Self.decode(Answer.self, "review.decide").review
        let changes = try Self.decode(Answer.self, "review.decide:changes").review
        #expect(approved.state == "approved" && approved.note == nil)
        #expect(changes.state == "changes" && changes.note == "Say it ships Friday in the caption too")
        #expect(approved.id == changes.id)
    }

    /// Every task, the next to run first: its cadence in the desktop's words, its last run's state in
    /// them too, whether that run is read, and the session it ran in.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theScheduledTasksSayWhenTheyRunAndHowTheyLastWent() throws {
        struct Answer: Decodable { let tasks: [ScheduledTask] }
        let tasks = try Self.decode(Answer.self, "schedules.list").tasks
        #expect(tasks.map(\.title) == ["Morning brief", "Weekly review", "Watch CI"])
        let brief = tasks[0]
        #expect(brief.when == "Weekdays at 8:00 AM" && brief.enabled)
        #expect(brief.lastRun == ScheduledTask.LastRun(state: "Finished", sessionId: "01JBRIEF000000000000000000", unread: true))
        #expect(tasks[1].lastRun == nil && tasks[1].lastRunAt == nil)
        #expect(!tasks[2].enabled && tasks[2].nextRunAt == nil && tasks[2].lastRun?.state == "Failed")
        let armed = tasks.filter { $0.enabled && $0.nextRunAt != nil }.compactMap(\.nextRunAt)
        #expect(armed == armed.sorted())
        // Run now answers with the task and the run it started.
        let started = try Self.decode([String: ScheduledTask].self, "schedules.runNow")["task"]
        #expect(started?.id == tasks[1].id && started?.lastRun?.state == "Starting")
        #expect((started?.lastRunAt ?? 0) > (tasks[0].lastRunAt ?? 0))
    }

    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theSubagentsAndWorkEventsDecode() throws {
        let subagents = try Self.event("session.subagents")
        guard case .sessionSubagents(let id)? = subagents.first else {
            Issue.record("session.subagents did not decode")
            return
        }
        #expect(id == "01JSESSION00000000000000000")
        guard case .workChanged? = try Self.event("work.changed").first else {
            Issue.record("work.changed did not decode")
            return
        }
    }
}
