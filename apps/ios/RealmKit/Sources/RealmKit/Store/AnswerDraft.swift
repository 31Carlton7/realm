import Foundation

/// What the person has picked on a question card so far. It is only ever an answer when they send
/// it: putting the sheet away keeps the picks for next time and answers nothing.
public struct AnswerDraft: Sendable, Equatable {
    public let sessionId: String
    public let requestId: String
    public let questions: [Question]
    /// Question text → the labels picked.
    public private(set) var picks: [String: Set<String>] = [:]
    /// Question text → an answer in the person's own words.
    public private(set) var others: [String: String] = [:]

    public init(sessionId: String, requestId: String, questions: [Question]) {
        self.sessionId = sessionId
        self.requestId = requestId
        self.questions = questions
    }

    public func isPicked(_ label: String, in question: Question) -> Bool {
        picks[question.question]?.contains(label) == true
    }

    public func other(for question: Question) -> String {
        others[question.question] ?? ""
    }

    /// One choice of a single-select question replaces the last, and words of its own as well; on a
    /// multi-select question each option toggles.
    public mutating func toggle(_ label: String, in question: Question) {
        var chosen = picks[question.question] ?? []
        if question.multiSelect {
            if chosen.contains(label) { chosen.remove(label) } else { chosen.insert(label) }
        } else {
            chosen = chosen.contains(label) ? [] : [label]
            others[question.question] = nil
        }
        picks[question.question] = chosen
    }

    /// Words of the person's own. On a single-select question they stand instead of an option.
    public mutating func setOther(_ text: String, for question: Question) {
        guard question.takesText else { return }
        others[question.question] = text
        if !question.multiSelect, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            picks[question.question] = []
        }
    }

    /// `session.answer`'s `answers`: question text → its labels in the order the options list them,
    /// then the person's own words; several joined with ", ", as the desktop's question card does.
    public var answers: [String: String] {
        var answers: [String: String] = [:]
        for question in questions where answers[question.question] == nil {
            var parts = question.options.map(\.label).filter { isPicked($0, in: question) }
            let own = other(for: question).trimmingCharacters(in: .whitespacesAndNewlines)
            if question.takesText, !own.isEmpty { parts.append(own) }
            if !parts.isEmpty { answers[question.question] = parts.joined(separator: ", ") }
        }
        return answers
    }

    /// `session.answer`'s `answers` as the desktop's card hands them back: under each question's key,
    /// the picked options' values in the order the options list them, then the person's own words —
    /// a multi-select question's as a list. A Phase 1 Mac sent no question keys and reads one string
    /// per question, so its questions are answered as `answers` answers them.
    public var values: [String: AnswerValue] {
        var values: [String: AnswerValue] = [:]
        for question in questions where values[question.answerKey] == nil {
            var parts = question.options.filter { isPicked($0.label, in: question) }.map(\.answerValue)
            let own = other(for: question).trimmingCharacters(in: .whitespacesAndNewlines)
            if question.takesText, !own.isEmpty { parts.append(own) }
            guard !parts.isEmpty else { continue }
            values[question.answerKey] = question.multiSelect && question.id != nil ? .several(parts) : .one(parts.joined(separator: ", "))
        }
        return values
    }

    /// Every question has an answer.
    public var isComplete: Bool {
        let answered = answers
        return !questions.isEmpty && questions.allSatisfy { answered[$0.question] != nil }
    }
}
