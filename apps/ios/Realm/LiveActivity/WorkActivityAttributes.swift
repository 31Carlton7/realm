import ActivityKit
import Foundation
import RealmKit

/// The session a Live Activity follows, fixed for the activity's life: built into the app and the
/// widget extension both, which is how ActivityKit matches the one's requests to the other's views.
struct WorkActivityAttributes: ActivityAttributes {
    typealias ContentState = WorkActivityContent

    let sessionId: String
    let title: String
    /// The agent's mark in the asset catalog (`Agents/<name>`), where it has one.
    let agentIcon: String?
    /// The vendor's colour for that mark, where the agent's identity is the point.
    let agentColor: String?
    /// The teammate whose chat this is: its mark stands where the agent's would.
    let teammate: TeammateIcon?
}
