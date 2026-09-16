import Foundation

/// ISO-8601 parsing that accepts both `2026-09-15T10:20:30.123Z` and
/// `2026-09-15T10:20:30Z` (and numeric offsets).
public enum ISO8601 {
    private struct Formatters: @unchecked Sendable {
        let fractional: ISO8601DateFormatter
        let plain: ISO8601DateFormatter

        init() {
            fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
        }
    }

    // ISO8601DateFormatter is documented as thread-safe.
    private static let formatters = Formatters()

    public static func date(from string: String) -> Date? {
        formatters.fractional.date(from: string) ?? formatters.plain.date(from: string)
    }

    public static func string(from date: Date) -> String {
        formatters.fractional.string(from: date)
    }
}

public enum JSONCoding {
    public static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let number = try? container.decode(Double.self) {
                // Most numeric timestamps are epoch milliseconds (`ts` fields);
                // Session `activityAt` is epoch seconds. Anything below 1e11 is
                // seconds (that boundary is the year 5138 in seconds, 1973 in ms).
                return Date(timeIntervalSince1970: number < 100_000_000_000 ? number : number / 1000)
            }
            let string = try container.decode(String.self)
            guard let date = ISO8601.date(from: string) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Unrecognized ISO-8601 date: \(string)"
                )
            }
            return date
        }
        return decoder
    }

    public static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ISO8601.string(from: date))
        }
        return encoder
    }
}
