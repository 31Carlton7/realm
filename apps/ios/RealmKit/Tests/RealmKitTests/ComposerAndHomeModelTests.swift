import Foundation
@testable import RealmKit
import Testing

/// What Plan 29 added to mobile.v1: profiles and recent sessions on Home, a space's own page, a session's
/// options and the changes to them, and the files a message carried.
@Suite("mobile.v1 models for the composer and Home (Plan 29)")
struct ComposerAndHomeModelTests {
    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    static func object(_ value: some Encodable) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    /// Set up again since its conversation last moved: its row was written after its last activity.
    static let row = #"""
    {"id":"s1","title":"Fix the flaky test","spaceId":"sp1","spaceName":"Realm","agent":"claude","model":null,"status":"idle",
     "needsYou":false,"unread":false,"updatedAt":1790000000000,"createdAt":1789000000000,"effort":"high","permissionMode":"plan",
     "activityAt":1789900000000}
    """#

    @Test func aRowCarriesWhenItWasMadeAndItsSettings() throws {
        let row = try Self.decode(SessionRow.self, Self.row)
        #expect(row.createdAt == 1_789_000_000_000)
        #expect(row.effort == "high")
        #expect(row.permissionMode == "plan")
        #expect(row.mode == .plan)
        // Its age is its conversation's, not the later write's.
        #expect(row.activityAt == 1_789_900_000_000)
        #expect(row.lastActivity == 1_789_900_000_000)
        #expect(row == SessionRow(id: "s1", title: "Fix the flaky test", spaceId: "sp1", spaceName: "Realm", agent: "claude", model: nil,
                                  status: .idle, needsYou: false, unread: false, updatedAt: 1_790_000_000_000,
                                  createdAt: 1_789_000_000_000, effort: "high", permissionMode: "plan", activityAt: 1_789_900_000_000))
        // And back again, as the cache writes it.
        let again = try JSONDecoder().decode(SessionRow.self, from: JSONEncoder().encode(row))
        #expect(again == row)
    }

    @Test func aRowFromAnOlderMacHasNoneOfThem() throws {
        let row = try Self.decode(SessionRow.self, #"{"id":"s1","title":"t","spaceId":"x","spaceName":"y","agent":"codex","model":null,"status":"idle","needsYou":false,"unread":false,"updatedAt":1}"#)
        #expect(row.createdAt == nil)
        #expect(row.effort == nil)
        #expect(row.mode == nil)
        // An older Mac's row is as old as its last write, and the cache writes back no time it never sent.
        #expect(row.activityAt == nil)
        #expect(row.lastActivity == 1)
        #expect(try Self.object(row)["activityAt"] == nil)
    }

    @Test func aStoredPermissionModeReadsAsItsMode() {
        #expect(SessionMode.of("plan") == .plan)
        #expect(SessionMode.of("ask") == .ask)
        #expect(SessionMode.of("default") == .build)
        #expect(SessionMode.of("bypassPermissions") == .build)
    }

    @Test func homeCarriesProfilesTheirSpacesAndRecentSessions() throws {
        let home = try Self.decode(Home.self, #"""
        {"mac":{"name":"MacBook Pro"},"needsYou":[],
         "spaces":[{"id":"sp1","name":"Realm","icon":"emoji:🌊","color":"#7c6cff","sessions":[\#(Self.row)],"more":0,"profileId":"p1"}],
         "profiles":[{"id":"p1","name":"Work","icon":"emoji:🛠️","color":"#6b7280","iconKind":"emoji","emoji":"🛠️","needsYou":2},
                     {"id":"p2","name":"School","icon":"book","color":"#6b7280","iconKind":"glyph","glyph":"book","needsYou":0}],
         "profileId":"p1","recent":[\#(Self.row)]}
        """#)
        #expect(home.profiles?.map(\.name) == ["Work", "School"])
        #expect(home.profiles?.first?.needsYou == 2)
        #expect(home.profiles?.first?.emoji == "🛠️")
        #expect(home.profiles?.last?.iconKind == .glyph)
        #expect(home.spaces.first?.profileId == "p1")
        #expect(home.profileId == "p1")
        #expect(home.recent?.map(\.id) == ["s1"])
        let again = try JSONDecoder().decode(Home.self, from: JSONEncoder().encode(home))
        #expect(again == home)
    }

    @Test func homeFromAnOlderMacHasNoProfiles() throws {
        let home = try Self.decode(Home.self, #"{"mac":{"name":"Mac"},"needsYou":[],"spaces":[{"id":"sp1","name":"Realm","icon":"x","color":"y","sessions":[],"more":0}]}"#)
        #expect(home.profiles == nil)
        #expect(home.recent == nil)
        #expect(home.spaces.first?.profileId == nil)
    }

    @Test func aSpacesPageDecodes() throws {
        let page = try Self.decode(SpaceSessions.self, #"{"sessions":[\#(Self.row)],"more":true}"#)
        #expect(page.sessions.count == 1)
        #expect(page.more)
    }

    static let options = #"""
    {"agent":{"kind":"claude","name":"Claude","mark":"claude","available":true,"note":null,
              "models":[{"id":null,"label":"Default","efforts":[{"id":"low","label":"Low"},{"id":"high","label":"High"}],"defaultEffort":"high"},
                        {"id":"claude-opus-5-5","label":"Opus 5.5"}],
              "efforts":[],"modes":[{"id":"build","label":"Build"},{"id":"plan","label":"Plan"}],
              "permissions":[{"id":"default","label":"Ask each time"},{"id":"acceptEdits","label":"Accept edits"}],
              "steerNote":"Sends now."},
     "model":"claude-opus-5-5","modelLabel":"Opus 5.5","effort":null,"permissionMode":"acceptEdits","midTurn":"queue",
     "attachments":{"maxCount":6,"maxBytes":8388608,"maxTotalBytes":10485760}}
    """#

    @Test func aSessionsOptionsDecode() throws {
        let options = try Self.decode(SessionOptions.self, Self.options)
        #expect(options.agent.name == "Claude")
        #expect(options.agent.models.map(\.id) == [nil, "claude-opus-5-5"])
        #expect(options.agent.models.first?.efforts?.map(\.label) == ["Low", "High"])
        #expect(options.agent.models.first?.defaultEffort == "high")
        #expect(options.agent.modes.map(\.id) == ["build", "plan"])
        #expect(options.agent.permissions.count == 2)
        #expect(options.mode == .build)
        #expect(options.midTurn == .queue)
        #expect(options.attachments.maxCount == 6)
    }

    /// The chips change the moment a setting is picked, as the Mac will have it: the model by its row's
    /// name, Plan and Ask as the permission mode, a rung on its own as Build on that rung.
    @Test func aChangeShowsAsTheMacWillHaveIt() throws {
        let options = try Self.decode(SessionOptions.self, Self.options)
        #expect(options.currentModel?.label == "Opus 5.5")
        #expect(options.efforts.isEmpty, "Opus 5.5 takes no levels here, and the agent has none of its own")

        let toDefault = options.applying(SessionChanges(model: .some(nil)))
        #expect(toDefault.model == nil)
        #expect(toDefault.modelLabel == "Default")
        #expect(toDefault.efforts.map(\.id) == ["low", "high"])
        #expect(options.applying(SessionChanges(effort: .some("high"))).effort == "high")
        #expect(options.applying(SessionChanges(effort: .some(nil))).effort == nil)

        let plan = options.applying(SessionChanges(mode: .plan))
        #expect(plan.permissionMode == "plan" && plan.mode == .plan)
        #expect(options.applying(SessionChanges(mode: .ask)).mode == .ask)
        #expect(options.applying(SessionChanges(permission: "default")).permissionMode == "default")
        #expect(plan.applying(SessionChanges(mode: .build, permission: "acceptEdits")).permissionMode == "acceptEdits")
        // Back to Build with no rung named: the Mac puts the session's own back, which only it knows.
        let build = plan.applying(SessionChanges(mode: .build))
        #expect(build.mode == .build && build.permissionMode == nil)
        // Already in Build, nothing changes.
        #expect(options.applying(SessionChanges(mode: .build)).permissionMode == "acceptEdits")
        #expect(options.applying(SessionChanges()) == options)
    }

    @Test func theAgentsListDecodes() throws {
        let agent = try JSONSerialization.jsonObject(with: Data(Self.options.utf8)) as? [String: Any]
        let agentJSON = String(decoding: try JSONSerialization.data(withJSONObject: try #require(agent?["agent"])), as: UTF8.self)
        let list = try Self.decode(AgentList.self, #"{"agents":[\#(agentJSON)],"defaultAgent":"claude","midTurn":"steer","attachments":{"maxCount":6,"maxBytes":1,"maxTotalBytes":2}}"#)
        #expect(list.agents.map(\.kind) == ["claude"])
        #expect(list.defaultAgent == "claude")
        #expect(list.midTurn == .steer)
    }

    @Test func anAgentsOwnLevelsSayWhichItStartsOn() throws {
        let agent = try Self.decode(AgentOptions.self, #"""
        {"kind":"acp:opencode","name":"OpenCode","mark":"opencode","available":true,"note":null,"models":[{"id":null,"label":"Default"}],
         "efforts":[{"id":"low","label":"Low"},{"id":"high","label":"Think hard"}],"defaultEffort":"low","modes":[{"id":"build","label":"Build"}],
         "permissions":[],"steerNote":"Sends now."}
        """#)
        #expect(agent.efforts.map(\.label) == ["Low", "Think hard"])
        #expect(agent.defaultEffort == "low")
        #expect(agent == AgentOptions(kind: "acp:opencode", name: "OpenCode", mark: "opencode", models: [ModelChoice(id: nil, label: "Default")],
                                      efforts: [Choice(id: "low", label: "Low"), Choice(id: "high", label: "Think hard")], defaultEffort: "low",
                                      modes: [Choice(id: "build", label: "Build")], steerNote: "Sends now."))
        #expect(try JSONDecoder().decode(AgentOptions.self, from: JSONEncoder().encode(agent)) == agent)
        // An agent that names no default, and one from an older Mac, say none.
        let unnamed = try Self.decode(AgentOptions.self, #"{"kind":"acp:goose","name":"goose","mark":"goose","available":true,"note":null,"models":[],"efforts":[{"id":"auto","label":"Auto"}],"defaultEffort":null,"modes":[],"permissions":[],"steerNote":""}"#)
        #expect(unnamed.defaultEffort == nil)
        #expect(try Self.decode(SessionOptions.self, Self.options).agent.defaultEffort == nil)
    }

    @Test func changesSayOnlyWhatChanges() throws {
        #expect(try Self.object(SessionChanges()).isEmpty)
        let model = try Self.object(SessionChanges(model: .some("claude-opus-5-5")))
        #expect(model["model"] as? String == "claude-opus-5-5")
        #expect(model["effort"] == nil)
        // The agent's own default is a null, not an absence.
        let backToDefault = try Self.object(SessionChanges(model: .some(nil), effort: .some(nil)))
        #expect(backToDefault["model"] is NSNull)
        #expect(backToDefault["effort"] is NSNull)
        let mode = try Self.object(SessionChanges(mode: .build, permission: "acceptEdits"))
        #expect(mode["mode"] as? String == "build")
        #expect(mode["permission"] as? String == "acceptEdits")
    }

    @Test func aFileGoesAsBase64() throws {
        let upload = try Self.object(AttachmentUpload(name: "photo.jpg", mime: "image/jpeg", bytes: Data([0xFF, 0xD8, 0xFF])))
        #expect(upload["name"] as? String == "photo.jpg")
        #expect(upload["data"] as? String == "/9j/")
    }

    @Test func aUserRowCarriesWhatWasSentWithIt() throws {
        let row = try Self.decode(TranscriptRow.self, #"""
        {"key":"u:3","seq":3,"kind":"user","text":"","attachments":[{"path":"/Users/me/Realm/tmp/attachments/ab12-photo.jpg","name":"ab12-photo.jpg","mime":"image/jpeg"},
                                                                   {"path":"/tmp/notes.pdf","name":"notes.pdf","mime":"application/pdf"}]}
        """#)
        guard case .user(let text) = row.content else {
            Issue.record("not a user row")
            return
        }
        #expect(text.isEmpty)
        #expect(row.sentFiles?.map(\.isImage) == [true, false])
        let again = try JSONDecoder().decode(TranscriptRow.self, from: JSONEncoder().encode(row))
        #expect(again == row)
    }
}
