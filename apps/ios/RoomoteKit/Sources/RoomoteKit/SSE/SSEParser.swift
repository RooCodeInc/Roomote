import Foundation

public struct SSEEvent: Sendable, Equatable {
    public var name: String
    public var data: String
    public var id: String?

    public init(name: String = "message", data: String, id: String? = nil) {
        self.name = name
        self.data = data
        self.id = id
    }

    /// Decodes the `data` payload as JSON.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONCoding.decoder.decode(type, from: Data(data.utf8))
    }

    public var json: JSONValue? {
        try? decode(JSONValue.self)
    }
}

/// Incremental `text/event-stream` line parser (WHATWG event stream format).
public struct SSEParser: Sendable {
    private var eventName = ""
    private var dataLines: [String] = []
    private var lastEventId: String?
    public private(set) var retryMilliseconds: Int?

    public init() {}

    /// Feeds one line (without its terminator). Returns an event when a blank
    /// line completes one.
    public mutating func feed(line rawLine: String) -> SSEEvent? {
        let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
        if line.isEmpty {
            defer {
                eventName = ""
                dataLines = []
            }
            guard !dataLines.isEmpty else { return nil }
            return SSEEvent(name: eventName.isEmpty ? "message" : eventName, data: dataLines.joined(separator: "\n"), id: lastEventId)
        }
        if line.hasPrefix(":") { return nil }

        let field: String
        var value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[..<colon])
            value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = line
            value = ""
        }

        switch field {
        case "event": eventName = value
        case "data": dataLines.append(value)
        case "id": lastEventId = value.isEmpty ? nil : value
        case "retry": retryMilliseconds = Int(value)
        default: break
        }
        return nil
    }

    /// Parses a complete buffer; convenient for tests and short responses.
    public static func parse(_ text: String) -> [SSEEvent] {
        var parser = SSEParser()
        var events: [SSEEvent] = []
        for line in text.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" }) {
            if let event = parser.feed(line: String(line)) { events.append(event) }
        }
        if let trailing = parser.feed(line: "") { events.append(trailing) }
        return events
    }
}

/// Extracts the largest `ts` cursor from a `messages` event payload.
public enum SSECursor {
    public static func maxTimestamp(in event: SSEEvent) -> Double? {
        guard event.name == "messages", let json = event.json else { return nil }
        let messages = json["messages"]?.arrayValue ?? []
        let stamps = messages.compactMap { $0["ts"]?.doubleValue }
        return stamps.max()
    }
}
