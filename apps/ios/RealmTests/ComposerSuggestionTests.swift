import RealmKit
import SwiftUI
import Testing
@testable import Realm

@MainActor
@Suite("The composer's / and @ on the phone")
struct ComposerSuggestionTests {
    @Test func aSentMessageShowsWhatItNamesAsTheDesktopsChipsDo() {
        let shown = UserBubble.named("@[designer] look at @[auth.ts], and mail me@[x.com")
        #expect(String(shown.characters) == "@designer look at @auth.ts, and mail me@[x.com")
        let accented = shown.runs.filter { $0.foregroundColor != nil }.map { String(shown[$0.range].characters) }
        #expect(accented == ["@designer", "@auth.ts"])
    }

    @Test func theListIsTheModesThenGoalThenAttachThenThePersonsOwn() {
        let commands = ComposerCommand.list(modes: [Choice(id: "build", label: "Build"), Choice(id: "plan", label: "Plan")], goal: true, attach: true,
                                            user: [UserCommand(name: "changelog", description: "Write the changelog", argumentHint: "<version>")])
        #expect(commands.map(\.id) == ["build", "plan", "goal", "attach", "changelog"])
        #expect(Suggestions.commands(commands).count == 5)
    }
}
