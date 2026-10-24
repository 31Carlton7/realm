import Foundation
@testable import RealmKit
import Testing

/// The composer's half of Plan 29 as the Mac writes it (`packages/remote/test/fixtures/ts-api.json`): a
/// session's options and the answer to a change of them, the agents a session could be given, and a
/// message that carried files.
@Suite("The composer's options and files as the Mac writes them")
struct ComposerFixtureTests {
    static let available = APIFixtureTests.available

    static func options(_ key: String) throws -> SessionOptions { try APIFixtureTests.decode(SessionOptions.self, "calls", key) }

    /// A pinned model's session: its models by the desktop's names, each with the levels it takes, its
    /// modes and rungs, what Steer does to it, and the limits on one message.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aSessionsOptionsCarryWhatTheChipsAndTheSheetShow() throws {
        let options = try Self.options("session.options")
        #expect(options.agent.name == "Claude" && options.agent.mark == "claude")
        #expect(options.model == "claude-opus-5-5" && options.modelLabel == "Opus 5.5")
        #expect(options.currentModel?.label == "Opus 5.5")
        // A pinned model cannot be put back on the default, so the Mac offers no default row.
        #expect(!options.agent.models.contains { $0.id == nil })
        #expect(options.efforts.map(\.label) == ["Low", "Medium", "High", "XHigh", "Max"])
        #expect(options.effort == "high")
        #expect(options.agent.modes.map(\.id) == ["build", "plan", "ask"])
        #expect(options.agent.permissions.map(\.label) == ["Ask each time", "Accept edits", "Full access"])
        #expect(options.mode == .build && options.permissionMode == "acceptEdits")
        #expect(options.midTurn == .steer)
        #expect(options.agent.steerNote.hasPrefix("Sends now. Claude stops the running turn"))
        #expect(options.attachments == SendLimits(maxCount: 6, maxBytes: 8 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024))
        // A model with no levels has none to offer.
        let haiku = options.applying(SessionChanges(model: .some("claude-haiku-4-5")))
        #expect(haiku.modelLabel == "Haiku 4.5" && haiku.efforts.isEmpty)
    }

    /// A session on its agent's default: the default's row has no id and the default's name, and a
    /// Cursor session has modes but no rungs Realm can set.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theDefaultIsARowWithoutAnIdAndAnAgentWithoutRungsHasNone() throws {
        let codex = try Self.options("session.options:codex")
        #expect(codex.model == nil && codex.modelLabel == "GPT-5.6")
        #expect(codex.currentModel == ModelChoice(id: nil, label: "GPT-5.6", efforts: codex.currentModel?.efforts,
                                                  defaultEffort: codex.currentModel?.defaultEffort))
        #expect(codex.agent.steerNote == "Sends now, into the turn Codex is already running. Nothing is interrupted.")
        let cursor = try Self.options("session.options:cursor")
        #expect(cursor.agent.permissions.isEmpty)
        #expect(cursor.agent.modes.count == 3)
        #expect(cursor.modelLabel == "Composer 2")
    }

    /// The answer to a change is the options as they are now, which the chips take up.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aChangesAnswerIsTheOptionsAsTheyAreNow() throws {
        let changed = try Self.options("session.configure")
        #expect(changed.model == "claude-sonnet-5" && changed.modelLabel == "Sonnet 5")
        #expect(changed.effort == "medium" && changed.permissionMode == "bypassPermissions")
        // What the phone showed while the change travelled is what the Mac answered.
        let before = try Self.options("session.options")
        #expect(before.applying(SessionChanges(model: .some("claude-sonnet-5"), effort: .some("medium"), permission: "bypassPermissions")) == changed)
        let plan = try Self.options("session.configure:plan")
        #expect(plan.mode == .plan && plan.permissionMode == "plan")
        #expect(plan.agent.kind == "codex")
    }

    /// The agents a new session could be given: each with whether it can run, and the Mac's own pick.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func theAgentsListSaysWhichCanRun() throws {
        let list = try APIFixtureTests.decode(AgentList.self, "calls", "agents.list")
        #expect(list.agents.first?.kind == "claude")
        #expect(list.defaultAgent == "codex")
        #expect(list.midTurn == .steer)
        let gemini = try #require(list.agents.first { $0.kind == "acp:gemini" })
        #expect(!gemini.available && gemini.note == "not installed")
        #expect(list.agents.first { $0.kind == "acp:opencode" }?.defaultEffort == "low")
        #expect(list.agents.first?.models.first?.id == nil, "a new session can start on the default")
    }

    /// A message that carried files names each as it was sent, by the path the Mac previews it by.
    @Test(.enabled(if: available, "ts-api.json is not written yet (the server's suite writes it)"))
    func aMessageNamesTheFilesItCarried() throws {
        let opened = try APIFixtureTests.opened()
        let row = try #require(opened.rows.first { $0.sentFiles != nil })
        #expect(row.content == .user(text: "File the issue, then plan the column"))
        let files = try #require(row.sentFiles)
        #expect(files.map(\.name) == ["IMG_0042.jpg", "brief.pdf"])
        #expect(files.map(\.isImage) == [true, false])
        #expect(files[0].path.hasSuffix("-IMG_0042.jpg"))
        let preview = try APIFixtureTests.decode(FilePreview.self, "calls", "session.file:attachment")
        #expect(preview.path == files[0].path && preview.name == "IMG_0042.jpg")
        #expect(preview.preview == .image(mime: "image/jpeg", data: Data("jpeg".utf8)))
    }
}
