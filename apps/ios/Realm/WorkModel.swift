import Observation
import RealmKit

/// What the Mac keeps beyond Home that the phone shows: Teams' open reviews and the scheduled tasks,
/// which Home's head and its menu count; the plans' limits and this month's spend; each space's
/// teammates; and the sub-agents of each session opened here. Asked when the channel opens and again
/// when the Mac says they changed (`work.changed`, `session.subagents`); what was last known stays
/// while the Mac is away.
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
    /// What each session's info sheet says beyond its row, as last read.
    private(set) var info: [String: SessionInfo] = [:]
    /// The Mac is older than `session.info`: the sheet says what the row says, and does not ask again.
    private(set) var infoUnsupported = false
    /// Every space's teammates, each space's Lead first, as the Mac last listed them; nil until it has.
    private(set) var teammates: [Teammate]?
    /// The Mac is older than teammates: Home has no Team, and nothing asks again.
    private(set) var teamUnsupported = false
    /// Every space's teammates put away, folded at the Team's end; empty from a Mac before archiving
    /// reached the phone.
    private(set) var archivedTeammates: [Teammate] = []

    /// The Mac's calls while this phone is connected to it; nil while it is away.
    @ObservationIgnored var api: @MainActor () -> MobileAPI? = { nil }
    /// Reviews and tasks are asked for again on every change the Mac reports: an answer overtaken by
    /// a later ask is not shown. The same for each session's sub-agents.
    @ObservationIgnored private var asks = 0
    @ObservationIgnored private var shown = 0
    @ObservationIgnored private var subagentAsks: [String: Int] = [:]
    @ObservationIgnored private var teamAsks = 0

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

    /// The teammates, read again with Home: a teammate's state is its sessions', and the share
    /// extension offers them.
    func loadTeam() async {
        guard let api = api(), !teamUnsupported else { return }
        teamAsks += 1
        let ask = teamAsks
        do {
            let list = try await api.teammates()
            let archived = (try? await api.archivedTeammates()) ?? archivedTeammates
            guard ask == teamAsks else { return }
            teammates = list
            archivedTeammates = archived
        } catch {
            if case ChannelError.rpc(let refusal) = error, refusal.code == "METHOD_NOT_FOUND" { teamUnsupported = true }
        }
    }

    func teammate(_ id: String) -> Teammate? { teammates?.first { $0.id == id } }

    /// The teammate whose chat this session is.
    func teammate(chat sessionId: String) -> Teammate? { teammates?.first { $0.chatId == sessionId } }

    /// The session a teammate's chat is, made on the Mac the first time it is asked for.
    func chat(of teammate: Teammate) async throws -> String {
        if let chatId = teammate.chatId { return chatId }
        guard let api = api() else { throw ChannelError.notConnected }
        let chatId = try await api.teammateChat(id: teammate.id)
        await loadTeam()
        return chatId
    }

    /// Saves an Edit sheet; the list takes the teammate as the Mac now names it at once. The Lead goes
    /// by its own call, as the Mac's sheet and menu make it.
    func save(_ edit: TeammateEdit, to teammate: Teammate) async throws {
        guard let api = api() else { throw ChannelError.notConnected }
        var fields = edit
        fields.lead = nil
        if !fields.isEmpty {
            let saved = try await api.updateTeammate(id: teammate.id, fields)
            teamAsks += 1
            teammates = teammates?.map { $0.id == saved.id ? saved : $0 }
        }
        if let lead = edit.lead, lead != teammate.lead { try await setLead(lead ? teammate.id : nil, in: teammate.spaceId) }
    }

    /// A new teammate, made as the Mac's New teammate sheet makes one; the Team read again with it.
    func create(_ new: NewTeammate) async throws -> Teammate {
        guard let api = api() else { throw ChannelError.notConnected }
        let made = try await api.createTeammate(new)
        await loadTeam()
        return made
    }

    /// Makes a teammate its space's Lead, or leaves the space with none. The space's Team is what the
    /// Mac answers, the Lead first.
    func setLead(_ id: String?, in spaceId: String) async throws {
        guard let api = api() else { throw ChannelError.notConnected }
        let team = try await api.setLead(spaceId: spaceId, id: id)
        teamAsks += 1
        teammates = Self.replacing(spaceId, with: team, in: teammates ?? [])
    }

    /// Puts a teammate away, or brings it back.
    func archive(_ teammate: Teammate, _ archived: Bool = true) async throws {
        guard let api = api() else { throw ChannelError.notConnected }
        _ = try await api.archiveTeammate(id: teammate.id, archived: archived)
        await loadTeam()
    }

    /// A space's Team in the order it was dragged to, at once; the Mac's answer then stands, and a
    /// refusal puts back what the Mac has.
    func reorder(_ team: [Teammate], in spaceId: String) async throws {
        guard let api = api() else { throw ChannelError.notConnected }
        teamAsks += 1
        teammates = Self.replacing(spaceId, with: team, in: teammates ?? [])
        do {
            let answered = try await api.reorderTeam(spaceId: spaceId, order: team.map { TeamPlace(id: $0.id, group: $0.group) })
            teamAsks += 1
            teammates = Self.replacing(spaceId, with: answered, in: teammates ?? [])
        } catch {
            await loadTeam()
            throw error
        }
    }

    /// The list with one space's teammates swapped for these, where that space's stood.
    static func replacing(_ spaceId: String, with team: [Teammate], in list: [Teammate]) -> [Teammate] {
        guard let at = list.firstIndex(where: { $0.spaceId == spaceId }) else { return list + team }
        var out = list.filter { $0.spaceId != spaceId }
        out.insert(contentsOf: team, at: at)
        return out
    }

    /// Where a session runs, what it has cost and its files, read again each time its sheet opens.
    func loadInfo(_ sessionId: String) async {
        guard let api = api(), !infoUnsupported else { return }
        do {
            info[sessionId] = try await api.info(id: sessionId)
        } catch {
            if case ChannelError.rpc(let refusal) = error, refusal.code == "METHOD_NOT_FOUND" { infoUnsupported = true }
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
        info = [:]
        infoUnsupported = false
        teammates = nil
        teamUnsupported = false
        archivedTeammates = []
    }

    /// A Mac older than these calls says it has no such method: nothing here asks it again.
    private func noteRefusal(_ error: any Error) {
        if case ChannelError.rpc(let refusal) = error, refusal.code == "METHOD_NOT_FOUND" { unsupported = true }
    }
}
