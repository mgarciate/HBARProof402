import Foundation

nonisolated enum HTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
}

nonisolated struct APIRequest<Response: Decodable & Sendable>: Sendable {
    let method: HTTPMethod
    let path: String
    var body: Data?
    var headers: [String: String] = [:]
}

nonisolated enum APIClientError: LocalizedError, Equatable {
    case invalidResponse
    case httpStatus(Int, String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "The server returned an invalid response."
        case let .httpStatus(status, message):
            message.isEmpty ? "The server returned HTTP \(status)." : message
        case let .decoding(message):
            "The server response could not be decoded: \(message)"
        }
    }
}

actor APIClient {
    private let baseURL: URL
    private let bearerToken: String?
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private let maximumAttempts: Int

    init(
        baseURL: URL,
        bearerToken: String? = nil,
        session: URLSession = .shared,
        maximumAttempts: Int = 3
    ) {
        self.baseURL = baseURL
        self.bearerToken = bearerToken
        self.session = session
        self.maximumAttempts = max(1, maximumAttempts)
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func encode<Body: Encodable & Sendable>(_ body: Body) throws -> Data {
        try encoder.encode(body)
    }

    func send<Response>(_ request: APIRequest<Response>) async throws -> Response {
        let data = try await execute(request: makeURLRequest(from: request))
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw APIClientError.decoding(error.localizedDescription)
        }
    }

    func sendWithoutResponse(_ request: APIRequest<EmptyResponse>) async throws {
        _ = try await execute(request: makeURLRequest(from: request))
    }

    func upload(_ data: Data, to url: URL, contentType: String) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = HTTPMethod.put.rawValue
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        _ = try await execute(request: request)
    }

    private func makeURLRequest<Response>(from request: APIRequest<Response>) -> URLRequest {
        guard let url = URL(string: request.path, relativeTo: baseURL)?.absoluteURL else {
            preconditionFailure("API request paths must be valid relative URLs.")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.httpBody = request.body
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if request.body != nil {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let bearerToken {
            urlRequest.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        request.headers.forEach { urlRequest.setValue($0.value, forHTTPHeaderField: $0.key) }
        return urlRequest
    }

    private func execute(request: URLRequest) async throws -> Data {
        var lastError: Error?
        for attempt in 1...maximumAttempts {
            do {
                let (data, response) = try await session.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw APIClientError.invalidResponse
                }
                if 200..<300 ~= httpResponse.statusCode {
                    return data
                }
                let message = (try? JSONDecoder().decode(ServerError.self, from: data).message) ?? ""
                let error = APIClientError.httpStatus(httpResponse.statusCode, message)
                guard isRetryable(status: httpResponse.statusCode), attempt < maximumAttempts else {
                    throw error
                }
                lastError = error
            } catch {
                guard isRetryable(error: error), attempt < maximumAttempts else { throw error }
                lastError = error
            }
            try await Task.sleep(for: .milliseconds(100 * (1 << (attempt - 1))))
        }
        throw lastError ?? APIClientError.invalidResponse
    }

    private func isRetryable(status: Int) -> Bool {
        status == 408 || status == 429 || 500...599 ~= status
    }

    private func isRetryable(error: Error) -> Bool {
        if case let APIClientError.httpStatus(status, _) = error {
            return isRetryable(status: status)
        }
        return error is URLError
    }
}

nonisolated struct EmptyResponse: Codable, Sendable {}
private nonisolated struct ServerError: Decodable {
    let message: String
}
