import Foundation
import Synchronization
import Testing
@testable import _02_ios

@Suite(.serialized)
struct FieldProofTests {
    @Test
    func evidenceHashAndQRValidationAreDeterministic() {
        let data = Data("field-proof".utf8)
        let first = EvidenceProcessor.sha256(data)
        let second = EvidenceProcessor.sha256(data)

        #expect(first == second)
        #expect(first.hasPrefix("sha256:"))
        #expect(EvidenceProcessor.qrMatches(value: "field-proof", expectedHash: first))
        #expect(!EvidenceProcessor.qrMatches(value: "different", expectedHash: first))
    }

    @Test
    func draftStorePreservesEvidenceAndIdempotencyKeys() throws {
        let fileURL = temporaryFileURL()
        let store = FileDraftStore(fileURL: fileURL)
        let draft = InspectionDraft(
            selectedTask: sampleTask(),
            phase: .evidence,
            payoutAccount: "0.0.123456",
            scannedQR: "FIELDPROOF:bike_demo_01",
            evidence: [
                CapturedEvidence(
                    id: UUID(),
                    type: .assetOverview,
                    jpegData: Data([1, 2, 3]),
                    sha256: EvidenceProcessor.sha256(Data([1, 2, 3]))
                )
            ],
            visibleDamage: false,
            receiptEvents: [],
            claimIdempotencyKey: UUID(),
            submissionIdempotencyKey: UUID()
        )

        try store.save(draft)
        let loadedDraft = try store.load()
        let restored = try #require(loadedDraft)

        #expect(restored == draft)
        try store.clear()
        let clearedDraft = try store.load()
        #expect(clearedDraft == nil)
    }

    @Test
    func apiClientRetriesTransientFailuresAndPreservesHeaders() async throws {
        let attempts = Mutex(0)
        URLProtocolStub.handler = { request in
            let currentAttempt = attempts.withLock {
                $0 += 1
                return $0
            }
            #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "stable-key")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
            #expect(request.url?.path == "/v1/tasks")
            #expect(request.url?.query == nil)
            let status = currentAttempt < 3 ? 500 : 200
            let data = status == 200 ? Data(#"{"value":"ok"}"#.utf8) : Data(#"{"message":"temporary"}"#.utf8)
            return (status, data)
        }
        defer { URLProtocolStub.handler = nil }

        let client = APIClient(
            baseURL: URL(string: "https://fieldproof.test")!,
            bearerToken: "test-token",
            session: stubSession(),
            maximumAttempts: 3
        )
        let response: TestResponse = try await client.send(
            APIRequest(
                method: .get,
                path: "v1/tasks",
                headers: ["Idempotency-Key": "stable-key"]
            )
        )

        #expect(response.value == "ok")
        #expect(attempts.withLock { $0 } == 3)
    }

    @Test
    func apiClientDoesNotRetryClientErrors() async {
        let attempts = Mutex(0)
        URLProtocolStub.handler = { _ in
            attempts.withLock { $0 += 1 }
            return (400, Data(#"{"message":"invalid request"}"#.utf8))
        }
        defer { URLProtocolStub.handler = nil }

        let client = APIClient(baseURL: URL(string: "https://fieldproof.test")!, session: stubSession(), maximumAttempts: 3)

        do {
            let _: TestResponse = try await client.send(APIRequest(method: .get, path: "v1/tasks"))
            Issue.record("Expected the request to fail.")
        } catch let error as APIClientError {
            #expect(error == .httpStatus(400, "invalid request"))
        } catch {
            Issue.record("Unexpected error: \(error)")
        }

        #expect(attempts.withLock { $0 } == 1)
    }

    @Test
    func signedUploadDoesNotReceiveMarketplaceBearerToken() async throws {
        URLProtocolStub.handler = { request in
            #expect(request.httpMethod == "PUT")
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            return (200, Data())
        }
        defer { URLProtocolStub.handler = nil }

        let client = APIClient(
            baseURL: URL(string: "https://fieldproof.test")!,
            bearerToken: "test-token",
            session: stubSession(),
            maximumAttempts: 1
        )

        try await client.upload(
            Data([1, 2, 3]),
            to: URL(string: "https://storage.test/upload")!,
            contentType: "image/jpeg"
        )
    }

    @MainActor
    @Test
    func claimReusesIdempotencyKeyAfterFailureAndAppRestart() async throws {
        let service = RetryingClaimService()
        let fileURL = temporaryFileURL()
        let store = FileDraftStore(fileURL: fileURL)

        var model: AppModel? = AppModel(service: service, draftStore: store)
        model?.select(sampleTask())
        model?.payoutAccount = "0.0.123456"
        await model?.validateAndClaim()
        #expect(model?.phase == .payout)

        model = AppModel(service: service, draftStore: store)
        model?.payoutAccount = "0.0.123456"
        await model?.validateAndClaim()

        let keys = await service.claimKeys
        #expect(keys.count == 2)
        #expect(keys.first == keys.last)
        #expect(model?.phase == .qr)
    }

    private func stubSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [URLProtocolStub.self]
        return URLSession(configuration: configuration)
    }

    private func temporaryFileURL() -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString)
            .appending(path: "draft.json")
    }

    private func sampleTask() -> FieldTask {
        let qrValue = "FIELDPROOF:bike_demo_01"
        return FieldTask(
            id: "task_01",
            status: .open,
            assetExternalId: "bike_demo_01",
            expectedQrHash: EvidenceProcessor.sha256(Data(qrValue.utf8)),
            title: "Verify Bicycle Condition",
            instructions: ["Scan the QR code."],
            rewardAmount: 5,
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            policyVersion: "bike-visual-v1"
        )
    }
}

private nonisolated struct TestResponse: Decodable, Sendable {
    let value: String
}

private final class URLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }

        do {
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private actor RetryingClaimService: FieldProofService {
    private(set) var claimKeys: [UUID] = []

    func availableTasks() async throws -> [FieldTask] {
        []
    }

    func claim(taskID: String, payoutAccount: String, idempotencyKey: UUID) async throws {
        claimKeys.append(idempotencyKey)
        if claimKeys.count == 1 {
            throw URLError(.timedOut)
        }
    }

    func submit(
        taskID: String,
        qrValue: String,
        evidence: [CapturedEvidence],
        visibleDamage: Bool,
        idempotencyKey: UUID
    ) async throws -> [ReceiptEvent] {
        []
    }
}
