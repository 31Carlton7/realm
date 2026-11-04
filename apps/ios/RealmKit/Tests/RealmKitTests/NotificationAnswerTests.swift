import Foundation
@testable import RealmKit
import Testing

@Suite("Answers from a notification (§4.3)")
struct NotificationAnswerTests {
    func payload(kind: String = "permission", session: String? = "s1", request: String? = "req-1", category: String? = "permission") -> PushPayload {
        PushPayload(id: "push-1", at: 1_790_000_000_000, kind: kind, title: "Fix the flaky test", body: "Wants to run pnpm test",
                    session: session, request: request, category: category)
    }

    @Test func aPayloadCarriesItsRequestAndCategory() throws {
        let json = #"{"v":1,"id":"p","at":1,"kind":"permission","title":"T","body":"B","session":"s1","request":"req-1","category":"permission.site"}"#
        let decoded = try JSONDecoder().decode(PushPayload.self, from: Data(json.utf8))
        #expect(decoded.request == "req-1")
        #expect(decoded.category == "permission.site")
    }

    @Test func aPayloadFromAnOlderMacHasNeither() throws {
        let json = #"{"v":1,"id":"p","at":1,"kind":"finished","title":"T","body":"B","session":null}"#
        let decoded = try JSONDecoder().decode(PushPayload.self, from: Data(json.utf8))
        #expect(decoded.request == nil)
        #expect(decoded.category == nil)
        #expect(NotificationAnswer.category(of: decoded) == "finished")
    }

    @Test(arguments: ["permission", "permission.space", "permission.site", "reply"])
    func aKnownCategoryIsTheOneFiled(category: String) {
        #expect(NotificationAnswer.category(of: payload(category: category)) == category)
    }

    @Test func anUnknownCategoryOrAPermissionWithoutItsRequestFallsBackToTheKind() {
        #expect(NotificationAnswer.category(of: payload(category: "permission.galaxy")) == "permission")
        #expect(NotificationAnswer.category(of: payload(kind: "question", request: nil, category: "permission")) == "question")
        // A reply needs no request.
        #expect(NotificationAnswer.category(of: payload(kind: "finished", request: nil, category: "reply")) == "reply")
    }

    @Test func theExtensionLeavesTheSessionAndTheRequest() {
        #expect(NotificationAnswer.userInfo(of: payload()) == ["session": "s1", "request": "req-1"])
        #expect(NotificationAnswer.userInfo(of: payload(session: nil, request: nil, category: nil)).isEmpty)
    }

    @Test func eachPermissionActionIsTheDecisionItNames() {
        let info: [AnyHashable: Any] = ["session": "s1", "request": "req-1"]
        #expect(NotificationAnswer(action: "allow", userInfo: info) == .decide(session: "s1", request: "req-1", .allow))
        #expect(NotificationAnswer(action: "allow_always", userInfo: info) == .decide(session: "s1", request: "req-1", .allowAlways))
        #expect(NotificationAnswer(action: "deny", userInfo: info) == .decide(session: "s1", request: "req-1", .deny))
    }

    @Test func aReplyIsItsWordsTrimmed() {
        let info: [AnyHashable: Any] = ["session": "s1"]
        #expect(NotificationAnswer(action: "reply", userInfo: info, text: "  Ship it\n") == .reply(session: "s1", text: "Ship it"))
        #expect(NotificationAnswer(action: "reply", userInfo: info, text: "   ") == nil)
        #expect(NotificationAnswer(action: "reply", userInfo: info, text: nil) == nil)
    }

    @Test func aTapADismissalOrMissingIdsAnswerNothing() {
        let info: [AnyHashable: Any] = ["session": "s1", "request": "req-1"]
        #expect(NotificationAnswer(action: "com.apple.UNNotificationDefaultActionIdentifier", userInfo: info) == nil)
        #expect(NotificationAnswer(action: "com.apple.UNNotificationDismissActionIdentifier", userInfo: info) == nil)
        #expect(NotificationAnswer(action: "allow", userInfo: ["session": "s1"]) == nil)
        #expect(NotificationAnswer(action: "allow", userInfo: ["request": "req-1"]) == nil)
    }
}
