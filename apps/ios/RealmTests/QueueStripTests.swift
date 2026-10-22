import Foundation
import RealmKit
import SwiftUI
import Testing
@testable import Realm

@MainActor
@Suite("The Mac's queue over the composer")
struct QueueStripTests {
    static let photo = SentFile(path: "/home/tmp/attachments/a1-Photo.jpg", name: "Photo.jpg", mime: "image/jpeg")
    static let brief = SentFile(path: "/home/tmp/attachments/b2-brief.pdf", name: "brief.pdf", mime: "application/pdf")
    static let first = QueuedMessage(id: "q1", text: "Then check the toolbar", at: 1)
    static let second = QueuedMessage(id: "q2", text: "Then run the tests", attachments: [photo], at: 2)

    /// A model with session `s1` open in `status`, the Mac's queue holding `queued`.
    static func model(_ status: SessionStatus, queued: [QueuedMessage]) -> AppModel {
        let model = modelWithSession(status: status)
        model.store.apply(.sessionQueue(SessionQueueEvent(id: "s1", queued: queued)))
        return model
    }

    @Test func theHeadSaysHowManyWaitOnTheMac() {
        #expect(QueueWords.title(1) == "Queued on your Mac")
        #expect(QueueWords.title(2) == "2 queued on your Mac")
    }

    /// From three it keeps to its head, and at the accessibility sizes from one: there a row is as tall
    /// as the transcript it would cover. Its button opens the queue in a sheet.
    @Test func itFoldsFromThreeAndAtTheLargestSizesAlways() {
        #expect(!QueueWords.folds(2, accessibilitySize: false))
        #expect(QueueWords.folds(3, accessibilitySize: false))
        #expect(QueueWords.folds(1, accessibilitySize: true))
        #expect(QueueWords.show(1) == "Show" && QueueWords.show(3) == "Show all")
    }

    /// While a turn is under way they go as it ends; once it is stopped they wait for the next turn's end,
    /// and Send now is the way to send one sooner. One being edited holds them.
    @Test func itSaysWhenTheyGoAndThatAfterStopTheyWait() {
        #expect(QueueWords.line(count: 1, working: true, held: false) == "Sends when this turn ends.")
        #expect(QueueWords.line(count: 2, working: true, held: false) == "They send in order, one as each turn ends.")
        #expect(QueueWords.line(count: 1, working: false, held: false) == "Waits for the next turn to end. Send now sends it at once.")
        #expect(QueueWords.line(count: 3, working: false, held: false) == "They wait for the next turn to end. Send now sends one at once.")
        #expect(QueueWords.line(count: 2, working: true, held: true) == "Nothing goes while one is being edited.")
        #expect(QueueWords.line(count: 1, working: false, held: true) == "It waits while it is being edited.")
    }

    /// A row is its words, or its files where it has none; VoiceOver hears which of how many it is.
    @Test func aRowSaysItsWordsItsFilesAndItsHold() {
        #expect(QueueWords.text(Self.first) == "Then check the toolbar")
        #expect(QueueWords.text(QueuedMessage(id: "q", text: " \n", attachments: [Self.photo], at: 0)) == "Photo.jpg")
        #expect(QueueWords.files([]) == nil)
        #expect(QueueWords.files([Self.photo, Self.brief]) == "Photo.jpg and brief.pdf")
        #expect(QueueWords.files([Self.photo, Self.brief, Self.photo]) == "Photo.jpg and 2 more")
        let held = QueuedMessage(id: "q2", text: "Then run the tests", attachments: [Self.photo], at: 2, held: true)
        #expect(QueueWords.spoken(held, at: 1, of: 2, editingHere: false)
                == "Queued message 2 of 2, Then run the tests, with Photo.jpg, Being edited elsewhere")
        #expect(QueueWords.spoken(Self.first, at: 0, of: 1, editingHere: false) == "Queued message 1 of 1, Then check the toolbar")
        #expect(QueueWords.held(editingHere: true) == "Held while you edit")
    }

    /// A message this iPhone sent that the Mac queued is drawn once, in the queue: its outgoing row goes
    /// from the transcript's foot even while its answer is still on the way.
    @Test func aMessageTheMacQueuedIsDrawnOnceInTheQueue() {
        var outbox = Outbox()
        let queued = OutgoingItem(sessionId: "s1", payload: .message(text: "Then check the toolbar"), state: .sending, afterSeq: 0)
        let waiting = OutgoingItem(sessionId: "s1", payload: .message(text: "Go on"), afterSeq: 0)
        let answer = OutgoingItem(sessionId: "s1", payload: .answer(requestId: "r1", decision: .allow, answers: nil), afterSeq: 0)
        for item in [queued, waiting, answer] { outbox.add(item) }
        var transcript = Transcript()
        #expect(SessionView.outgoing(outbox, transcript, in: "s1").map(\.id) == [queued.id, waiting.id])
        transcript.queued = [Self.first]
        #expect(SessionView.outgoing(outbox, transcript, in: "s1").map(\.id) == [waiting.id])
    }

    /// Two waiting while the turn runs: the head, both rows with their files, and what Send now does.
    @Test func theStripDrawsWhatWaits() throws {
        let words = try Drawing.words(QueueStrip(sessionId: "s1").environment(Self.model(.running, queued: [Self.first, Self.second])))
        #expect(words.contains("2 queued on your Mac"), "\(words)")
        #expect(words.contains("Then check the toolbar") && words.contains("Then run the tests"), "\(words)")
        #expect(words.contains("Photo.jpg"), "\(words)")
    }

    /// After Stop it says they wait for the next turn, and from three it folds to the next one.
    @Test func afterStopItSaysTheyWaitAndFromThreeItFolds() throws {
        let third = QueuedMessage(id: "q3", text: "Then open the PR", at: 3)
        let words = try Drawing.words(QueueStrip(sessionId: "s1").environment(Self.model(.idle, queued: [Self.first, Self.second, third])),
                                      dark: false)
        #expect(words.contains("3 queued on your Mac") && words.contains("wait for the next turn"), "\(words)")
        #expect(words.contains("Next: Then check the toolbar") && words.contains("Show all"), "\(words)")
        #expect(!words.contains("Then open the PR"), "folded, only the next one is named")
    }

    /// At the largest size it keeps to its head, and the way to the queue.
    @Test func atTheLargestSizeItKeepsToItsHead() throws {
        let words = try Drawing.words(QueueStrip(sessionId: "s1").environment(Self.model(.running, queued: [Self.first])),
                                      size: .accessibility5)
        #expect(words.contains("Queued on") && words.contains("Show"), "\(words)")
    }

    @Test func withNothingQueuedThereIsNoStrip() throws {
        let words = try Drawing.words(QueueStrip(sessionId: "s1").environment(Self.model(.running, queued: [])))
        #expect(words.isEmpty, "\(words)")
    }
}
