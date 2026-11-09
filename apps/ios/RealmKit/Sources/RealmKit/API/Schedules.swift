import Foundation

/// An expression in the Repeat rows' terms, as the Mac reads it back (`ScheduledTask.cadence`). A
/// `once` has its moment in `at`; a `custom` is an expression the rows cannot name.
public struct TaskCadence: Codable, Sendable, Hashable {
    public enum Repeat: String, Codable, Sendable, Hashable {
        case once, hourly, daily, weekdays, weekly, monthly, custom
    }

    public let `repeat`: Repeat
    public let hour: Int?
    public let minute: Int?
    /// 0 is Sunday, as cron has it.
    public let weekday: Int?
    public let day: Int?
    public let at: Millis?

    public init(repeat: Repeat, hour: Int? = nil, minute: Int? = nil, weekday: Int? = nil, day: Int? = nil, at: Millis? = nil) {
        self.repeat = `repeat`
        self.hour = hour
        self.minute = minute
        self.weekday = weekday
        self.day = day
        self.at = at
    }
}

/// A task the Scheduled page offers to start from.
public struct SuggestedTask: Codable, Sendable, Hashable, Identifiable {
    public let title: String
    /// What it does, in a line.
    public let blurb: String
    public let goal: String
    public let cadence: TaskCadence

    public var id: String { title }

    public init(title: String, blurb: String, goal: String, cadence: TaskCadence) {
        self.title = title
        self.blurb = blurb
        self.goal = goal
        self.cadence = cadence
    }
}

/// `schedules.list`. `suggested` is nil from a Mac too old to change a task from here.
public struct ScheduledList: Decodable, Sendable, Hashable {
    public let tasks: [ScheduledTask]
    public let suggested: [SuggestedTask]?
}

/// `schedules.when`: when an expression would next fire on the Mac's clock, nil where it never would,
/// and its sentence.
public struct TaskWhen: Decodable, Sendable, Hashable {
    public let next: Millis?
    public let when: String
}

/// `schedules.create`: a new task, as the desktop's Schedule a task sheet makes one.
public struct NewTask: Encodable, Sendable, Hashable {
    public let spaceId: String
    public let title: String
    public let goal: String
    public let cron: String
    public let agent: String
    public let model: String?
    public let effort: String?
    public let newSessionPerRun: Bool
    public let archiveSucceeded: Bool

    public init(spaceId: String, title: String, goal: String, cron: String, agent: String, model: String?, effort: String?, newSessionPerRun: Bool, archiveSucceeded: Bool) {
        self.spaceId = spaceId
        self.title = title
        self.goal = goal
        self.cron = cron
        self.agent = agent
        self.model = model
        self.effort = effort
        self.newSessionPerRun = newSessionPerRun
        self.archiveSucceeded = archiveSucceeded
    }
}

/// `schedules.update`: only what is set changes. A new `agent` takes `model` and `effort` with it, and
/// leaving those out is the agent's own default.
public struct TaskEdit: Encodable, Sendable, Hashable {
    public var spaceId: String?
    public var title: String?
    public var goal: String?
    public var cron: String?
    public var enabled: Bool?
    public var agent: String?
    public var model: String?
    public var effort: String?
    public var newSessionPerRun: Bool?
    public var archiveSucceeded: Bool?

    public init(enabled: Bool? = nil) {
        self.enabled = enabled
    }

    public var isEmpty: Bool { self == TaskEdit() }
}

/// `teammate.checkIn`: a teammate's check-in as its sheet on the desktop sets it. Only what is set changes.
public struct CheckInEdit: Encodable, Sendable, Hashable {
    public var cron: String?
    public var prompt: String?
    public var enabled: Bool?

    public init(cron: String? = nil, prompt: String? = nil, enabled: Bool? = nil) {
        self.cron = cron
        self.prompt = prompt
        self.enabled = enabled
    }

    public var isEmpty: Bool { self == CheckInEdit() }
}
