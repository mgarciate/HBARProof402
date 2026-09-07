import Foundation

nonisolated enum TaskStatus: String, Codable, CaseIterable, Sendable {
    case open = "OPEN"
    case claimed = "CLAIMED"
    case evidenceSubmitted = "EVIDENCE_SUBMITTED"
    case verifying = "VERIFYING"
    case approved = "APPROVED"
    case rejected = "REJECTED"
    case manualReview = "MANUAL_REVIEW"
    case paid = "PAID"

    var title: String {
        switch self {
        case .open: "Available"
        case .claimed: "Claimed"
        case .evidenceSubmitted: "Evidence Submitted"
        case .verifying: "Verifying"
        case .approved: "Approved"
        case .rejected: "Rejected"
        case .manualReview: "Manual Review"
        case .paid: "Paid"
        }
    }

    var systemImage: String {
        switch self {
        case .open: "tray.full"
        case .claimed: "person.crop.circle.badge.checkmark"
        case .evidenceSubmitted: "arrow.up.circle"
        case .verifying: "hourglass"
        case .approved: "checkmark.seal"
        case .rejected: "xmark.octagon"
        case .manualReview: "person.crop.circle.badge.questionmark"
        case .paid: "checkmark.circle.fill"
        }
    }
}

nonisolated struct FieldTask: Identifiable, Codable, Hashable, Sendable {
    let id: String
    var status: TaskStatus
    let assetExternalId: String
    let expectedQrHash: String
    let title: String
    let instructions: [String]
    let rewardAmount: Decimal
    let expiresAt: Date
    let policyVersion: String

    var rewardText: String {
        rewardAmount.formatted(.number.precision(.fractionLength(0...2))) + " HBAR"
    }
}

nonisolated struct CapturedEvidence: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let type: EvidenceType
    let jpegData: Data
    let sha256: String

    enum EvidenceType: String, Codable, Hashable, Sendable, Identifiable {
        var id: String { rawValue }

        case assetOverview = "asset_overview"
        case componentDetail = "component_detail"

        var title: String {
            switch self {
            case .assetOverview: "Full Side View"
            case .componentDetail: "Component Detail"
            }
        }

        var systemImage: String {
            switch self {
            case .assetOverview: "bicycle"
            case .componentDetail: "camera.macro"
            }
        }
    }
}

nonisolated struct ReceiptEvent: Identifiable, Codable, Hashable, Sendable {
    let id: UUID
    let title: String
    let detail: String
    let date: Date
    let systemImage: String
    let externalURL: URL?
}

nonisolated enum AppPhase: String, Codable, Hashable, Sendable {
    case tasks
    case payout
    case qr
    case evidence
    case submission
    case result
}

nonisolated struct InspectionDraft: Codable, Equatable, Sendable {
    var selectedTask: FieldTask?
    var phase: AppPhase
    var payoutAccount: String
    var scannedQR: String?
    var evidence: [CapturedEvidence]
    var visibleDamage: Bool
    var receiptEvents: [ReceiptEvent]
    var claimIdempotencyKey: UUID
    var submissionIdempotencyKey: UUID

    static func empty() -> InspectionDraft {
        InspectionDraft(
            selectedTask: nil,
            phase: .tasks,
            payoutAccount: "",
            scannedQR: nil,
            evidence: [],
            visibleDamage: false,
            receiptEvents: [],
            claimIdempotencyKey: UUID(),
            submissionIdempotencyKey: UUID()
        )
    }
}
