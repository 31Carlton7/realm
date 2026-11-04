import ActivityKit
import Foundation
import RealmKit

/// Each working session's Live Activity, as this app runs it: started when the person sends a message
/// or a session they are looking at starts a turn, updated from what the channel to the Mac says, and
/// ended with the turn on Done or Needs you.
///
/// Only the app updates it. The relay sends one kind of push, an alert to the app's own token, so an
/// activity cannot be moved on while the app is suspended: once iOS takes the channel away the
/// activity says it is out of date until the app is opened again.
@MainActor
final class WorkActivities {
    /// Settings ▸ Show on Lock Screen. On unless the person turns it off.
    static let enabledKey = "liveActivities"
    /// How long an update stands before the Lock Screen draws it as out of date: past this the app has
    /// likely been suspended, and the turn may have moved on without it.
    nonisolated static let freshFor: TimeInterval = 15 * 60

    private struct Live {
        let activity: Activity<WorkActivityAttributes>
        var content: WorkActivityContent
        /// The Mac has said the turn is under way: an idle session after this is a finished one.
        var turnSeen: Bool
        /// The Lock Screen was told it is out of date: the next word from the Mac goes, changed or not.
        var outOfDate = false
    }

    private var live: [String: Live] = [:]

    var enabled: Bool { UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true }
    var isLive: Bool { !live.isEmpty }
    func isLive(_ sessionId: String) -> Bool { live[sessionId] != nil }
    /// The sessions followed, with when each one's turn began.
    var following: [(sessionId: String, startedAt: Date)] { live.map { ($0.key, $0.value.content.startedAt) } }

    /// Activities a previous run of the app left: nothing follows them now, so they go.
    func endLeftovers() async {
        let followed = Set(live.values.map(\.activity.id))
        let ids = Activity<WorkActivityAttributes>.activities.map(\.id).filter { !followed.contains($0) }
        await Task.detached {
            for id in ids { await Self.activity(id)?.end(nil, dismissalPolicy: .immediate) }
        }.value
    }

    func start(_ trigger: WorkActivityRules.Trigger, _ subject: WorkActivityAttributes, content: WorkActivityContent,
               turnUnderWay: Bool) {
        let allowed = ActivityAuthorizationInfo().areActivitiesEnabled
        guard WorkActivityRules.shouldStart(trigger, enabled: enabled, allowed: allowed, live: isLive(subject.sessionId)) else { return }
        do {
            let activity = try Activity.request(attributes: subject, content: Self.fresh(content))
            live[subject.sessionId] = Live(activity: activity, content: content, turnSeen: turnUnderWay)
        } catch {
            print("[realm] live activity: \(error.localizedDescription)")
        }
    }

    /// Moves a session's activity on to `content`, or ends it there once the turn is over. Nil, and a
    /// finish heard before the turn began, change nothing.
    func update(_ sessionId: String, to content: WorkActivityContent?, turnUnderWay: Bool) {
        guard var entry = live[sessionId] else { return }
        // Stale is still live: it is the out-of-date state this update is here to clear. Swiped away or
        // ended, it is gone.
        switch entry.activity.activityState {
        case .active, .stale: break
        default:
            live[sessionId] = nil
            return
        }
        if turnUnderWay { entry.turnSeen = true }
        live[sessionId] = entry
        guard let content else { return }
        if WorkActivityRules.ends(content, turnSeen: entry.turnSeen) {
            live[sessionId] = nil
            let id = entry.activity.id
            Task.detached {
                await Self.activity(id)?.end(ActivityContent(state: content, staleDate: nil),
                                             dismissalPolicy: .after(Date().addingTimeInterval(WorkActivityContent.dismissal)))
            }
            return
        }
        // Until the Mac starts the turn, the first state stands.
        guard !content.isFinal, content != entry.content || entry.outOfDate else { return }
        entry.content = content
        entry.outOfDate = false
        live[sessionId] = entry
        let id = entry.activity.id
        Task.detached { await Self.activity(id)?.update(Self.fresh(content)) }
    }

    /// The channel is going while activities are live: each says so at once, rather than standing as
    /// though the turn had stopped where it was.
    func markOutOfDate() {
        for (sessionId, entry) in live {
            live[sessionId]?.outOfDate = true
            let id = entry.activity.id, content = entry.content
            Task.detached { await Self.activity(id)?.update(ActivityContent(state: content, staleDate: Date())) }
        }
    }

    /// Show on Lock Screen turned off, or the Mac forgotten: every activity goes at once.
    func endAll() {
        let ids = live.values.map(\.activity.id)
        live = [:]
        Task.detached {
            for id in ids { await Self.activity(id)?.end(nil, dismissalPolicy: .immediate) }
        }
    }

    /// ActivityKit's own handle on an activity, found by its id where it is used: the handle cannot be
    /// handed from the main actor to the task that updates it.
    private nonisolated static func activity(_ id: String) -> Activity<WorkActivityAttributes>? {
        Activity<WorkActivityAttributes>.activities.first { $0.id == id }
    }

    private nonisolated static func fresh(_ content: WorkActivityContent) -> ActivityContent<WorkActivityContent> {
        ActivityContent(state: content, staleDate: Date().addingTimeInterval(freshFor))
    }
}

extension AppModel {
    /// Starts a session's activity: when the person sends it a message, and when one they are looking at
    /// starts a turn.
    func startActivity(_ sessionId: String, _ trigger: WorkActivityRules.Trigger) {
        guard !activities.isLive(sessionId) else { return }
        let transcript = store.transcript(sessionId)
        guard let row = transcript.session ?? homeRow(sessionId) else { return }
        let teammate = work.teammate(chat: sessionId)
        let icon = AgentMark.icon(kind: row.agent, mark: row.agentMark)
        let subject = WorkActivityAttributes(sessionId: sessionId, title: teammate?.name ?? row.title, agentIcon: icon,
                                             agentColor: icon.flatMap { Marks.agentColors[$0] }, teammate: teammate?.icon)
        let startedAt = workingSince[sessionId] ?? Date()
        let now = activityContent(sessionId, startedAt: startedAt)
        let content = now.flatMap { $0.isFinal ? nil : $0 } ?? WorkActivityContent(phase: .working, step: "Working", startedAt: startedAt)
        activities.start(trigger, subject, content: content, turnUnderWay: turnUnderWay(sessionId))
    }

    /// Every live activity moved on to where its session stands now.
    func updateActivities() {
        for (sessionId, startedAt) in activities.following {
            activities.update(sessionId, to: activityContent(sessionId, startedAt: startedAt),
                              turnUnderWay: turnUnderWay(sessionId))
        }
    }

    private func turnUnderWay(_ sessionId: String) -> Bool {
        switch activityStatus(sessionId) {
        case .running, .waiting, .moving: true
        default: false
        }
    }

    /// Where a session stands: its transcript's word while it is open here, else its Home row's.
    private func activityStatus(_ sessionId: String) -> SessionStatus? {
        let transcript = store.transcript(sessionId)
        if transcript.isLive, let status = transcript.status ?? transcript.session?.status { return status }
        return homeRow(sessionId)?.status
    }

    /// What the activity says for a session as it stands: the work dock's step and plan, and the request
    /// that waits on the person.
    func activityContent(_ sessionId: String, startedAt: Date) -> WorkActivityContent? {
        let transcript = store.transcript(sessionId)
        let request = PendingRequest.first(in: transcript, outbox: store.outbox)?.request.title
        let needsYou = homeRow(sessionId)?.needsYou ?? transcript.session?.needsYou ?? false
        return WorkActivityContent.of(status: activityStatus(sessionId), needsYou: needsYou,
                                      step: CurrentStep.of(transcript)?.words, request: request,
                                      plan: transcript.todos.isEmpty ? nil : TodoProgress(transcript.todos),
                                      startedAt: startedAt)
    }

    /// A session's row as Home last listed it, wherever it is listed.
    func homeRow(_ sessionId: String) -> SessionRow? {
        guard let home = store.home else { return nil }
        let rows = home.needsYou + (home.recent ?? []) + home.spaces.flatMap(\.sessions)
        return rows.first { $0.id == sessionId }
    }
}
