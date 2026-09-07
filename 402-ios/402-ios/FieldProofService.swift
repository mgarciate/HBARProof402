import Foundation

nonisolated protocol FieldProofService: Sendable {
    func availableTasks() async throws -> [FieldTask]
    func claim(taskID: String, payoutAccount: String, idempotencyKey: UUID) async throws
    func submit(
        taskID: String,
        qrValue: String,
        evidence: [CapturedEvidence],
        visibleDamage: Bool,
        idempotencyKey: UUID
    ) async throws -> [ReceiptEvent]
}

actor LiveFieldProofService: FieldProofService {
    private let client: APIClient
    private let workerID: String

    init(client: APIClient, workerID: String) {
        self.client = client
        self.workerID = workerID
    }

    func availableTasks() async throws -> [FieldTask] {
        let response: TaskListResponse = try await client.send(
            APIRequest(method: .get, path: "v1/tasks?status=OPEN")
        )
        return response.tasks.map(\.model)
    }

    func claim(taskID: String, payoutAccount: String, idempotencyKey: UUID) async throws {
        let payoutBody = try await client.encode(PayoutAccountRequest(hederaAccountId: payoutAccount))
        try await client.sendWithoutResponse(
            APIRequest(
                method: .put,
                path: "v1/workers/\(workerID)/payout-account",
                body: payoutBody
            )
        )

        let claimBody = try await client.encode(ClaimRequest(workerId: workerID, payoutAccountId: payoutAccount))
        try await client.sendWithoutResponse(
            APIRequest(
                method: .post,
                path: "v1/tasks/\(taskID)/claim",
                body: claimBody,
                headers: ["Idempotency-Key": idempotencyKey.uuidString]
            )
        )
    }

    func submit(
        taskID: String,
        qrValue: String,
        evidence: [CapturedEvidence],
        visibleDamage: Bool,
        idempotencyKey: UUID
    ) async throws -> [ReceiptEvent] {
        let uploadRequest = PrepareUploadsRequest(
            files: evidence.map {
                PrepareUploadFile(type: $0.type.rawValue, sha256: $0.sha256, mimeType: "image/jpeg", byteCount: $0.jpegData.count)
            }
        )
        let uploadBody = try await client.encode(uploadRequest)
        let prepared: PrepareUploadsResponse = try await client.send(
            APIRequest(method: .post, path: "v1/tasks/\(taskID)/evidence/uploads", body: uploadBody)
        )

        for item in evidence {
            guard let destination = prepared.uploads.first(where: { $0.type == item.type.rawValue }) else {
                throw FieldProofError.missingUploadDestination(item.type.rawValue)
            }
            try await client.upload(item.jpegData, to: destination.uploadURL, contentType: "image/jpeg")
        }

        let manifest = SubmitEvidenceRequest(
            qrHash: EvidenceProcessor.sha256(Data(qrValue.utf8)),
            files: evidence.compactMap { item in
                guard let destination = prepared.uploads.first(where: { $0.type == item.type.rawValue }) else { return nil }
                return SubmittedFile(type: item.type.rawValue, sha256: item.sha256, storageKey: destination.storageKey)
            },
            answers: EvidenceAnswers(visibleDamage: visibleDamage)
        )
        let manifestBody = try await client.encode(manifest)
        try await client.sendWithoutResponse(
            APIRequest(
                method: .post,
                path: "v1/tasks/\(taskID)/evidence",
                body: manifestBody,
                headers: ["Idempotency-Key": idempotencyKey.uuidString]
            )
        )

        let receipt: ReceiptResponse = try await client.send(
            APIRequest(method: .get, path: "v1/tasks/\(taskID)/receipt/verify")
        )
        return receipt.events.map(\.model)
    }
}

enum FieldProofError: LocalizedError {
    case invalidPayoutAccount
    case qrMismatch
    case incompleteEvidence
    case cameraUnavailable
    case missingUploadDestination(String)

    var errorDescription: String? {
        switch self {
        case .invalidPayoutAccount:
            "Enter a Hedera testnet account in 0.0.x format."
        case .qrMismatch:
            "The QR code does not match this task's asset."
        case .incompleteEvidence:
            "Capture both required photos."
        case .cameraUnavailable:
            "The camera is unavailable on this device."
        case let .missingUploadDestination(type):
            "The server did not provide an upload destination for \(type)."
        }
    }
}

private nonisolated struct TaskListResponse: Decodable, Sendable {
    let tasks: [TaskDTO]

    init(from decoder: Decoder) throws {
        if let container = try? decoder.singleValueContainer(),
           let tasks = try? container.decode([TaskDTO].self) {
            self.tasks = tasks
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tasks = try container.decode([TaskDTO].self, forKey: .tasks)
    }

    private enum CodingKeys: String, CodingKey {
        case tasks
    }
}

private nonisolated struct TaskDTO: Decodable, Sendable {
    let id: String
    let status: TaskStatus
    let assetExternalId: String
    let expectedQrHash: String
    let title: String
    let instructions: [String]
    let reward: AmountDTO
    let expiresAt: Date
    let policyVersion: String

    var model: FieldTask {
        FieldTask(
            id: id,
            status: status,
            assetExternalId: assetExternalId,
            expectedQrHash: expectedQrHash,
            title: title,
            instructions: instructions,
            rewardAmount: Decimal(string: reward.amount) ?? 0,
            expiresAt: expiresAt,
            policyVersion: policyVersion
        )
    }
}

private nonisolated struct AmountDTO: Decodable, Sendable {
    let asset: String
    let amount: String
}

private nonisolated struct PayoutAccountRequest: Encodable, Sendable {
    let hederaAccountId: String
}

private nonisolated struct ClaimRequest: Encodable, Sendable {
    let workerId: String
    let payoutAccountId: String
}

private nonisolated struct PrepareUploadsRequest: Encodable, Sendable {
    let files: [PrepareUploadFile]
}

private nonisolated struct PrepareUploadFile: Encodable, Sendable {
    let type: String
    let sha256: String
    let mimeType: String
    let byteCount: Int
}

private nonisolated struct PrepareUploadsResponse: Decodable, Sendable {
    let uploads: [PreparedUpload]
}

private nonisolated struct PreparedUpload: Decodable, Sendable {
    let type: String
    let uploadURL: URL
    let storageKey: String
}

private nonisolated struct SubmitEvidenceRequest: Encodable, Sendable {
    let qrHash: String
    let files: [SubmittedFile]
    let answers: EvidenceAnswers
}

private nonisolated struct SubmittedFile: Encodable, Sendable {
    let type: String
    let sha256: String
    let storageKey: String
}

private nonisolated struct EvidenceAnswers: Encodable, Sendable {
    let visibleDamage: Bool
}

private nonisolated struct ReceiptResponse: Decodable, Sendable {
    let events: [ReceiptEventDTO]
}

private nonisolated struct ReceiptEventDTO: Decodable, Sendable {
    let id: UUID?
    let title: String
    let detail: String
    let timestamp: Date
    let systemImage: String?
    let externalURL: URL?

    var model: ReceiptEvent {
        ReceiptEvent(
            id: id ?? UUID(),
            title: title,
            detail: detail,
            date: timestamp,
            systemImage: systemImage ?? "checkmark.circle",
            externalURL: externalURL
        )
    }
}
