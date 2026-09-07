import CryptoKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

nonisolated enum EvidenceProcessor {
    static func sha256(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        let hash = digest.map { String(format: "%02x", $0) }.joined()
        return "sha256:\(hash)"
    }

    static func qrMatches(value: String, expectedHash: String) -> Bool {
        sha256(Data(value.utf8)).localizedCaseInsensitiveCompare(expectedHash) == .orderedSame
    }

#if canImport(UIKit)
    static func process(image: UIImage, type: CapturedEvidence.EvidenceType) throws -> CapturedEvidence {
        guard let data = image.jpegData(compressionQuality: 0.82) else {
            throw FieldProofError.cameraUnavailable
        }
        return CapturedEvidence(id: UUID(), type: type, jpegData: data, sha256: sha256(data))
    }
#endif
}
