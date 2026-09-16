import Foundation
import XCTest
@testable import RoomoteKit

final class DeepLinkTests: XCTestCase {
    func testCustomSchemeSession() {
        XCTAssertEqual(DeepLink(url: URL(string: "roomote://sessions/abc-123")!), .session(id: "abc-123"))
    }

    func testCustomSchemeTask() {
        XCTAssertEqual(DeepLink(url: URL(string: "roomote://tasks/t9")!), .task(id: "t9"))
    }

    func testAuthCode() {
        XCTAssertEqual(DeepLink(url: URL(string: "roomote://auth?code=xyz")!), .auth(code: "xyz"))
        XCTAssertEqual(DeepLink(url: URL(string: "roomote://auth")!), .auth(code: nil))
    }

    func testUniversalLinks() {
        XCTAssertEqual(DeepLink(url: URL(string: "https://roo.roomote.ai/sessions/s1")!), .session(id: "s1"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://roo.roomote.ai/task/t1?tab=logs")!), .task(id: "t1"))
        XCTAssertEqual(DeepLink(url: URL(string: "https://roo.roomote.ai/tasks/t1")!), .task(id: "t1"))
    }

    func testUniversalLinkHostFilter() {
        let url = URL(string: "https://other.example.com/sessions/s1")!
        XCTAssertNil(DeepLink(url: url, deploymentHost: "roo.roomote.ai"))
        XCTAssertEqual(DeepLink(url: url, deploymentHost: "other.example.com"), .session(id: "s1"))
    }

    func testUnrelatedPathsAreNil() {
        XCTAssertNil(DeepLink(url: URL(string: "https://roo.roomote.ai/settings")!))
        XCTAssertNil(DeepLink(url: URL(string: "roomote://sessions")!))
        XCTAssertNil(DeepLink(url: URL(string: "https://roo.roomote.ai/auth?code=1")!))
        XCTAssertNil(DeepLink(url: URL(string: "mailto:someone@example.com")!))
    }

    func testCanonicalURLRoundTrips() {
        let link = DeepLink.session(id: "s 1")
        XCTAssertEqual(DeepLink(url: link.url!), link)
    }

    func testPushPayloadParsing() throws {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "t", "body": "b"], "category": "USER_INPUT"],
            "data": ["kind": "user_input", "sessionId": "s1", "fastConversationId": "fc1", "taskId": NSNull(),
                     "requestId": "r1", "url": "roomote://sessions/s1"],
        ]
        let payload = try XCTUnwrap(PushPayload(userInfo: userInfo))
        XCTAssertEqual(payload.kind, "user_input")
        XCTAssertEqual(payload.requestId, "r1")
        XCTAssertNil(payload.taskId)
        XCTAssertEqual(payload.category, "USER_INPUT")
        XCTAssertEqual(payload.deepLink, .session(id: "s1"))
    }
}
