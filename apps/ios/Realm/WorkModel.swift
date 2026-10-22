import Observation
import RealmKit

/// What the Mac keeps beyond Home that the phone shows: Teams' open reviews and the scheduled tasks,
/// which Home's head and its menu count; the plans' limits and this month's spend; and the sub-agents
/// of each session opened here. Asked when the channel opens and again when the Mac says they changed
/// (`work.changed`, `session.subagents`); what was last known stays while the Mac is away.
@MainActor
@Observable
final class WorkModel {
    /// The reviews still open, newest first, as the Mac last listed them; nil until it has.
    private(set) var reviews: [ReviewSummary]?
    /// Every scheduled task, the next to run first; nil until the Mac has listed them.
    private(set) var schedules: [ScheduledTask]?
    /// The plans' limits and this month's spend, as last read.
    private(set) var usage: Usage?
    /// The sub-agents of each session opened here, newest first.
    private(set) var subagents: [String: [Subagent]] = [:]
    /// The Mac answers none of these calls, being older than them: the pages are not offered.
    private(set) var unsupported = false

    /// The Mac's calls while this phone is connected to it; nil while it is away.
    @ObservationIgnored var api: @MainActor () -> MobileAPI? = { nil }
    /// Reviews and tasks are asked for again on every change the Mac reports: an answer overtaken by
    /// a later ask is not shown. The same for each session's sub-agents.
    @ObservationIgnored private var asks = 0
    @ObservationIgnored private var shown = 0
    @ObservationIgnored private var subagentAsks: [String: Int] = [:]

    /// Reviews and scheduled tasks, read again.
    func refresh() async {
        guard let api = api(), !unsupported else { return }
        asks += 1
        let ask = asks
        do {
            async let reviews = api.reviews()
            async let tasks = api.schedules()
            let (open, scheduled) = try await (reviews, tasks)
            guard ask > shown else { return }
            shown = ask
            self.reviews = ReviewOrder.newestFirst(open)
            schedules = TaskOrder.nextFirst(scheduled)
        } catch {
            noteRefusal(error)
        }
    }

    /// A session's sub-agents, read again: when it opens, and when the Mac says they changed.
    func loadSubagents(_ sessionId: String) async {
        guard let api = api(), !unsupported else { return }
        let ask = (subagentAsks[sessionId] ?? 0) + 1
        subagentAsks[sessionId] = ask
        do {
            let list = try await api.subagents(id: sessionId)
            guard subagentAsks[sessionId] == ask else { return }
            subagents[sessionId] = SubagentOrder.newestFirst(list)
        } catch {
            noteRefusal(error)
        }
    }

    /// The plans' limits and this month's spend, read again; why not, for the page to say.
    func loadUsage() async throws {
        guard let api = api() else { throw ChannelError.notConnected }
        do {
            usage = try await api.usage()
        } catch {
            noteRefusal(error)
            throw error
        }
    }

    func review(_ id: String) async throws -> ReviewDetail {
        guard let api = api() else { throw ChannelError.notConnected }
        return try await api.review(id: id)
    }

    /// A picture one of a review's items carries, as the Mac previews it.
    func picture(_ path: String, of reviewId: String) async throws -> FilePreview {
        guard let api = api() else { throw ChannelError.notConnected }
        return try await api.reviewFile(id: reviewId, path: path)
    }

    /// A decision on a review, as the Mac takes it. The review's row says what it is now at once,
    /// rather than at the Mac's next word.
    func decide(_ reviewId: String, _ decision: ReviewDecision, note: String?) async throws -> ReviewSummary {
        guard let api = api() else { throw ChannelError.notConnected }
        let review = try await api.decide(review: reviewId, decision, note: note)
        reviews = reviews?.map { $0.id == review.id ? review : $0 }
        return review
    }

    /// Runs a scheduled task now, as the Mac's Run now does; its row takes the run it started.
    func runNow(_ taskId: String) async throws -> ScheduledTask {
        guard let api = api() else { throw ChannelError.notConnected }
        let task = try await api.runNow(schedule: taskId)
        schedules = schedules?.map { $0.id == task.id ? task : $0 }
        return task
    }

    /// Everything kept of a Mac, when this phone forgets it or pairs with another.
    func forget() {
        reviews = nil
        schedules = nil
        usage = nil
        subagents = [:]
        subagentAsks = [:]
        unsupported = false
    }

    /// A Mac older than these calls says it has no such method: nothing here asks it again.
    private func noteRefusal(_ error: any Error) {
        if case ChannelError.rpc(let refusal) = error, refusal.code == "METHOD_NOT_FOUND" { unsupported = true }
    }
}
