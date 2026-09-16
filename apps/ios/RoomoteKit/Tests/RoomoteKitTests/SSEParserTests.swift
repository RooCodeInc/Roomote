import Foundation
import XCTest
@testable import RoomoteKit

final class SSEParserTests: XCTestCase {
    func testParsesNamedEventsAndMultilineData() {
        let text = """
        event: messages
        data: {"messages":[{"ts":5},{"ts":9}],"conversationResponding":true}

        : keep-alive
        event: chunk
        data: line one
        data: line two
        id: 7

        data: {"plain":true}

        """
        let events = SSEParser.parse(text)
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events[0].name, "messages")
        XCTAssertEqual(SSECursor.maxTimestamp(in: events[0]), 9)
        XCTAssertEqual(events[1].name, "chunk")
        XCTAssertEqual(events[1].data, "line one\nline two")
        XCTAssertEqual(events[1].id, "7")
        XCTAssertEqual(events[2].name, "message")
        XCTAssertEqual(events[2].data, #"{"plain":true}"#)
    }

    func testIncrementalFeedAndCRLF() {
        var parser = SSEParser()
        XCTAssertNil(parser.feed(line: "event: disconnect\r"))
        XCTAssertNil(parser.feed(line: "data:{}\r"))
        let event = parser.feed(line: "\r")
        XCTAssertEqual(event, SSEEvent(name: "disconnect", data: "{}"))
        XCTAssertNil(parser.feed(line: ""), "blank line without data does not dispatch")
    }

    func testRetryFieldIsRecorded() {
        var parser = SSEParser()
        _ = parser.feed(line: "retry: 2500")
        XCTAssertEqual(parser.retryMilliseconds, 2500)
    }

    func testCursorIgnoresNonMessageEvents() {
        XCTAssertNil(SSECursor.maxTimestamp(in: SSEEvent(name: "session", data: #"{"messages":[{"ts":1}]}"#)))
        XCTAssertNil(SSECursor.maxTimestamp(in: SSEEvent(name: "messages", data: "not json")))
    }
}
