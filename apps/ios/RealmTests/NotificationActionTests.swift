import Foundation
import RealmKit
import Testing
import UserNotifications
@testable import Realm

@MainActor
@Suite("Answering from a notification")
struct NotificationActionTests {
    func category(_ identifier: String) -> UNNotificationCategory? {
        NotificationKinds.categories.first { $0.identifier == identifier }
    }

    /// Every category a Mac can name has the actions the extension files it for.
    @Test func everyCategoryAMacNamesIsRegistered() {
        for identifier in NotificationAnswer.categories { #expect(category(identifier) != nil, "\(identifier)") }
    }

    @Test(arguments: [("permission", "Allow always"), ("permission.space", "Always allow in this space"),
                      ("permission.site", "Always allow on this site")])
    func aPermissionOffersTheDesktopCardsAnswers(identifier: String, always: String) throws {
        let actions = try #require(category(identifier)).actions
        #expect(actions.map(\.title) == ["Allow", always, "Deny"])
        #expect(actions.map(\.identifier) == ["allow", "allow_always", "deny"])
        // Each identifier is the decision `session.answer` takes.
        #expect(actions.compactMap { Decision(rawValue: $0.identifier) } == [.allow, .allowAlways, .deny])
    }

    @Test func allowingNeedsThePhoneUnlockedAndDenyingDoesNot() throws {
        let actions = try #require(category("permission")).actions
        #expect(actions[0].options.contains(.authenticationRequired))
        #expect(actions[1].options.contains(.authenticationRequired))
        #expect(!actions[2].options.contains(.authenticationRequired))
        #expect(actions[2].options.contains(.destructive))
    }

    @Test func aReplyIsTypedAndNeedsThePhoneUnlocked() throws {
        let actions = try #require(category("reply")).actions
        #expect(actions.count == 1)
        let reply = try #require(actions.first as? UNTextInputNotificationAction)
        #expect(reply.identifier == NotificationAnswer.Action.reply)
        #expect(reply.title == "Reply")
        #expect(reply.textInputButtonTitle == "Send")
        #expect(reply.options.contains(.authenticationRequired))
    }

    @Test(arguments: ["question", "finished", "failed", "blocked", "test"])
    func aKindAloneOffersNothing(identifier: String) throws {
        #expect(try #require(category(identifier)).actions.isEmpty)
    }

    @Test func aDecisionThatDidNotGoSaysWhichAndWhy() {
        let allow = NotificationAnswer.decide(session: "s1", request: "req-1", .allow)
        #expect(AppModel.notSent(allow, because: ChannelError.macOffline) == "Allow did not reach your Mac. Your Mac is asleep.")
        let deny = NotificationAnswer.decide(session: "s1", request: "req-1", .deny)
        #expect(AppModel.notSent(deny, because: ChannelError.timedOut) == "Deny did not reach your Mac. Your Mac did not answer in time.")
    }

    @Test func aRefusalIsTheMacsOwnWords() {
        let always = NotificationAnswer.decide(session: "s1", request: "req-1", .allowAlways)
        let refusal = ChannelError.rpc(RPCError(code: "NOT_FOUND", message: "That request was already answered."))
        #expect(AppModel.notSent(always, because: refusal) == "Allow always was refused: That request was already answered.")
    }

    @Test func aReplyThatDidNotGoKeepsItsWords() {
        let reply = NotificationAnswer.reply(session: "s1", text: "Ship it")
        #expect(AppModel.notSent(reply, because: ChannelError.macOffline) == "Your reply did not reach your Mac. Your Mac is asleep. You wrote: “Ship it”")
    }
}
