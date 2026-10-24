import Foundation
import RealmKit
import Testing
@testable import Realm

@MainActor
@Suite("What a new session starts with")
struct NewSessionTests {
    static let limits = SendLimits(maxCount: 6, maxBytes: 8, maxTotalBytes: 10)

    static func agent(_ kind: String, _ name: String, available: Bool = true, note: String? = nil,
                      models: [ModelChoice] = [ModelChoice(id: nil, label: "Opus 5.5"), ModelChoice(id: "claude-sonnet-5", label: "Sonnet 5")]) -> AgentOptions {
        AgentOptions(kind: kind, name: name, mark: kind, available: available, note: note, models: models,
                     modes: [Choice(id: "build", label: "Build"), Choice(id: "plan", label: "Plan"), Choice(id: "ask", label: "Ask")],
                     permissions: [Choice(id: "default", label: "Ask each time"), Choice(id: "acceptEdits", label: "Accept edits")])
    }

    static let list = AgentList(agents: [agent("claude", "Claude"), agent("codex", "Codex"),
                                         agent("acp:gemini", "Gemini", available: false, note: "not installed")],
                                defaultAgent: "codex", midTurn: .steer, attachments: limits)

    /// The profile Home shows lists the spaces; the last one started in is the default while that profile
    /// has it, else its first.
    @Test func theSpaceIsTheLastOneUsedWhereTheProfileHasIt() {
        let work = NewSessionDefaults.spaces(Staged.home, choice: .profile("work"))
        #expect(work.map(\.id) == ["realm", "site", "empty"])
        #expect(NewSessionDefaults.spaces(Staged.home, choice: .all).count == 4)
        #expect(NewSessionDefaults.space(lastUsed: "site", in: work)?.id == "site")
        #expect(NewSessionDefaults.space(lastUsed: "thesis", in: work)?.id == "realm")
        #expect(NewSessionDefaults.space(lastUsed: nil, in: work)?.id == "realm")
        #expect(NewSessionDefaults.space(lastUsed: "realm", in: []) == nil)
    }

    /// The Mac's own agent comes first and is the default; one that cannot run is never the default.
    @Test func theMacsAgentLeadsAndIsTheDefaultWhereItCanRun() {
        #expect(NewSessionDefaults.agents(Self.list).map(\.kind) == ["codex", "claude", "acp:gemini"])
        #expect(NewSessionDefaults.agent(Self.list)?.kind == "codex")
        let geminiFirst = AgentList(agents: Self.list.agents, defaultAgent: "acp:gemini", midTurn: .queue, attachments: Self.limits)
        #expect(NewSessionDefaults.agents(geminiFirst).first?.kind == "acp:gemini")
        #expect(NewSessionDefaults.agent(geminiFirst)?.kind == "claude", "the first that can run")
        let none = AgentList(agents: [Self.agent("acp:gemini", "Gemini", available: false)], defaultAgent: nil, midTurn: .queue,
                             attachments: Self.limits)
        #expect(NewSessionDefaults.agent(none) == nil)
    }

    /// An agent starts on its own default model, reasoning and Build at the Mac's own rung; one with no
    /// default row starts on its first model.
    @Test func anAgentStartsOnItsDefaults() {
        let options = NewSessionDefaults.options(Self.list.agents[0], in: Self.list)
        #expect(options.model == nil && options.modelLabel == "Opus 5.5")
        #expect(options.effort == nil && options.permissionMode == nil && options.mode == .build)
        #expect(options.midTurn == .steer && options.attachments == Self.limits)
        let pinned = Self.agent("codex", "Codex", models: [ModelChoice(id: "gpt-6-luna", label: "GPT-6 Luna")])
        #expect(NewSessionDefaults.options(pinned, in: Self.list).model == "gpt-6-luna")
    }

    /// The session is asked for only what was chosen: the rest is the Mac's own default.
    @Test func onlyWhatWasChosenIsAskedFor() {
        let defaults = NewSessionDefaults.options(Self.list.agents[0], in: Self.list)
        #expect(NewSessionDefaults.settings(defaults) == SessionChanges())
        let sonnet = defaults.applying(SessionChanges(model: .some("claude-sonnet-5"), effort: .some("high")))
        #expect(NewSessionDefaults.settings(sonnet) == SessionChanges(model: .some("claude-sonnet-5"), effort: .some("high")))
        let plan = sonnet.applying(SessionChanges(mode: .plan))
        #expect(NewSessionDefaults.settings(plan) == SessionChanges(model: .some("claude-sonnet-5"), effort: .some("high"), mode: .plan))
        let rung = plan.applying(SessionChanges(permission: "acceptEdits"))
        #expect(NewSessionDefaults.settings(rung) == SessionChanges(model: .some("claude-sonnet-5"), effort: .some("high"), permission: "acceptEdits"))
        // Back to Build on no rung named: the Mac's own rung.
        #expect(NewSessionDefaults.settings(plan.applying(SessionChanges(mode: .build))).permission == nil)
    }

    /// Start goes once there is a space, an agent that can run and something to send, with the Mac there;
    /// while it is away the line under the card says so.
    @Test func startGoesOnlyWithTheMacASpaceAnAgentAndAMessage() {
        let space = Staged.spaces[0]
        let claude = Self.list.agents[0]
        #expect(StartState(connected: true, space: space, agent: claude, hasContent: true, starting: false) == .ready)
        #expect(StartState(connected: true, space: space, agent: claude, hasContent: false, starting: false) == .empty)
        #expect(StartState(connected: false, space: space, agent: claude, hasContent: true, starting: false) == .away)
        #expect(StartState(connected: true, space: nil, agent: claude, hasContent: true, starting: false) == .noSpace)
        #expect(StartState(connected: true, space: space, agent: Self.list.agents[2], hasContent: true, starting: false) == .noAgent)
        #expect(StartState(connected: true, space: space, agent: nil, hasContent: true, starting: false) == .noAgent)
        #expect(StartState(connected: false, space: space, agent: claude, hasContent: true, starting: true) == .starting)
        #expect(StartState.away.note == "Start a session while your Mac is connected.")
        #expect(StartState.ready.note == nil && StartState.empty.note == nil && StartState.starting.note == nil)
        #expect(StartState.noSpace.note != nil && StartState.noAgent.note != nil)
    }

    /// While the Mac is away the sheet says Start waits for it.
    @Test func awayTheSheetSaysStartWaitsForTheMac() throws {
        let model = AppModel()
        model.store.showHome(Staged.home)
        model.agentList = Self.list
        model.composerDrafts[NewSessionDefaults.draft] = "Write the release notes"
        // A sheet fills what it is given: it is given a phone's height.
        let words = try Drawing.words(NewSessionSheet().frame(height: 700).environment(model), dark: false)
        #expect(words.contains("Start a session while your Mac is connected"), "\(words)")
        #expect(words.contains("Write the release notes") && words.contains("Realm") && words.contains("Codex"), "\(words)")
    }
}
