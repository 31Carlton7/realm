import Foundation
@testable import RealmKit
import Testing

@Suite("How a teammate is said")
struct TeammateWordsTests {
    static func teammate(_ id: String, state: TeammateState? = nil, lead: Bool = false, brief: String = "", activity: String? = nil) -> Teammate {
        Teammate(id: id, spaceId: "s1", name: id.capitalized, handle: id, brief: brief, lead: lead, chatId: nil, state: state, activity: activity)
    }

    static func call(_ key: String, to id: String?, handle: String) -> TranscriptRow {
        TranscriptRow(key: key, seq: 1, content: .tool(name: "team_message", summary: "", state: .done, detail: nil),
                      teammateCall: TeammateCall(id: id, handle: handle, message: "Hi"))
    }

    @Test func aBriefsFirstLineIsItsRole() {
        #expect(TeammateWords.role("## Owns the architecture\n\nAnd reviews migrations.") == "Owns the architecture")
        #expect(TeammateWords.role("\n\n- Keeps one design\n") == "Keeps one design")
        #expect(TeammateWords.role("> Quoted *and* kept") == "Quoted *and* kept")
        #expect(TeammateWords.role("") == "")
    }

    @Test func onlyAStateWorthActingOnIsSaid() {
        #expect(TeammateWords.state(.working) == "Working")
        #expect(TeammateWords.state(.needsYou) == "Needs you")
        #expect(TeammateWords.state(.idle) == nil)
        #expect(TeammateWords.state(nil) == nil, "an older Mac's teammate says nothing of its state")
    }

    @Test func aRowIsSpokenWhoFirstThenTheLeadThenHowItStands() {
        let cto = Self.teammate("cto", state: .needsYou, lead: true, brief: "Owns it", activity: "Review the plan")
        #expect(TeammateWords.spoken(cto) == "Cto, the Lead, Needs you, Review the plan")
        #expect(TeammateWords.spoken(Self.teammate("designer", brief: "Keeps one design")) == "Designer, Keeps one design")
    }

    /// The desktop's three rules: a call still waiting is working (or needs you, when the teammate does);
    /// the newest one answered says what the teammate is doing now; an older one is done.
    @Test func aCallSaysWhereItStands() {
        let working = Self.teammate("designer", state: .working)
        let asking = Self.teammate("designer", state: .needsYou)
        let idle = Self.teammate("designer", state: .idle)
        #expect(TeammateCallState(call: .running, teammate: idle, newest: false) == .working)
        #expect(TeammateCallState(call: .running, teammate: asking, newest: false) == .needsYou)
        #expect(TeammateCallState(call: .running, teammate: nil, newest: true) == .working)
        #expect(TeammateCallState(call: .done, teammate: working, newest: true) == .working)
        #expect(TeammateCallState(call: .done, teammate: asking, newest: true) == .needsYou)
        #expect(TeammateCallState(call: .done, teammate: working, newest: false) == .done, "an older ask is not told the newer one's work")
        #expect(TeammateCallState(call: .done, teammate: idle, newest: true) == .done)
        #expect(TeammateCallState(call: .done, teammate: nil, newest: true) == .done)
    }

    @Test func theNewestCallToEachTeammateIsTheOneThatSaysItsState() {
        let rows = [
            Self.call("a", to: "d", handle: "designer"), Self.call("b", to: "c", handle: "cto"),
            Self.call("c", to: "d", handle: "designer"), Self.call("d", to: nil, handle: "intern"),
            TranscriptRow(key: "e", seq: 2, content: .tool(name: "Bash", summary: "ls", state: .done, detail: nil)),
        ]
        #expect(TeammateCallState.newest(in: rows) == ["b", "c", "d"])
    }
}
