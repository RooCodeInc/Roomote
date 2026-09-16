import Foundation

/// Reconnecting Server-Sent Events client built on `URLSession.bytes(for:)`.
///
/// `makeRequest` receives the last seen cursor (max `ts`) so each reconnect
/// resumes where the previous connection stopped. A `disconnect` event or the
/// server closing the stream triggers an immediate reconnect; transport errors
/// back off exponentially up to `maxBackoff`.
public final class SSEClient: Sendable {
    public typealias RequestBuilder = @Sendable (_ since: Double?) async throws -> URLRequest
    public typealias CursorExtractor = @Sendable (SSEEvent) -> Double?

    private let session: URLSession
    private let makeRequest: RequestBuilder
    private let extractCursor: CursorExtractor
    private let minBackoff: Duration
    private let maxBackoff: Duration

    public init(
        session: URLSession = .shared,
        minBackoff: Duration = .seconds(1),
        maxBackoff: Duration = .seconds(30),
        cursor: @escaping CursorExtractor = SSECursor.maxTimestamp(in:),
        makeRequest: @escaping RequestBuilder
    ) {
        self.session = session
        self.minBackoff = minBackoff
        self.maxBackoff = maxBackoff
        self.extractCursor = cursor
        self.makeRequest = makeRequest
    }

    /// Events from the stream. Cancelling the consuming task closes the connection.
    public func events(since initialCursor: Double?) -> AsyncStream<SSEEvent> {
        AsyncStream { continuation in
            let task = Task { await self.run(initialCursor: initialCursor, continuation: continuation) }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func run(initialCursor: Double?, continuation: AsyncStream<SSEEvent>.Continuation) async {
        var since = initialCursor
        var backoff = minBackoff

        while !Task.isCancelled {
            var receivedEvent = false
            var wantsImmediateReconnect = false

            do {
                let request = try await makeRequest(since)
                let (bytes, response) = try await session.bytes(for: request)
                if let http = response as? HTTPURLResponse {
                    if http.statusCode == 401 || http.statusCode == 403 {
                        break
                    }
                    guard (200..<300).contains(http.statusCode) else {
                        throw RoomoteError.http(status: http.statusCode, message: "Stream rejected")
                    }
                }

                var parser = SSEParser()
                for try await line in bytes.lines {
                    if Task.isCancelled { break }
                    guard let event = parser.feed(line: line) else { continue }
                    receivedEvent = true
                    backoff = minBackoff
                    if let ts = extractCursor(event) {
                        since = max(since ?? 0, ts)
                    }
                    if event.name == "disconnect" {
                        wantsImmediateReconnect = true
                        break
                    }
                    continuation.yield(event)
                }
                if !Task.isCancelled {
                    // Server closed the stream (60-minute cap or disconnect): resume promptly.
                    wantsImmediateReconnect = wantsImmediateReconnect || receivedEvent
                }
            } catch is CancellationError {
                break
            } catch let error as URLError where error.code == .cancelled {
                break
            } catch {
                // Fall through to the backoff below.
            }

            if Task.isCancelled { break }
            if wantsImmediateReconnect {
                try? await Task.sleep(for: .milliseconds(250))
            } else {
                try? await Task.sleep(for: backoff)
                backoff = min(backoff * 2, maxBackoff)
            }
        }
        continuation.finish()
    }
}
