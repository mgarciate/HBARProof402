import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    private let service: any FieldProofService
    private let draftStore: any DraftStore

    var tasks: [FieldTask] = []
    var selectedTask: FieldTask?
    var phase: AppPhase = .tasks
    var payoutAccount = ""
    var scannedQR: String?
    var evidence: [CapturedEvidence] = []
    var visibleDamage = false
    var receiptEvents: [ReceiptEvent] = []
    var isLoading = false
    var errorMessage: String?

    private var claimIdempotencyKey = UUID()
    private var submissionIdempotencyKey = UUID()

    init(service: any FieldProofService, draftStore: any DraftStore) {
        self.service = service
        self.draftStore = draftStore
        restoreDraft()
    }

    convenience init() {
        let configuration = AppConfiguration.live
        let client = APIClient(baseURL: configuration.apiBaseURL)
        let service = LiveFieldProofService(client: client, workerID: configuration.workerID)
        self.init(service: service, draftStore: FileDraftStore())
    }

    func loadTasks() async {
        isLoading = true
        defer { isLoading = false }
        do {
            tasks = try await service.availableTasks()
            if let selectedTask, let index = tasks.firstIndex(where: { $0.id == selectedTask.id }) {
                tasks[index].status = selectedTask.status
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func select(_ task: FieldTask) {
        selectedTask = task
        phase = .payout
        errorMessage = nil
        claimIdempotencyKey = UUID()
        submissionIdempotencyKey = UUID()
        persistDraft()
    }

    func validateAndClaim() async {
        guard isValidHederaAccount(payoutAccount), let selectedTask else {
            errorMessage = FieldProofError.invalidPayoutAccount.localizedDescription
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            try await service.claim(
                taskID: selectedTask.id,
                payoutAccount: payoutAccount,
                idempotencyKey: claimIdempotencyKey
            )
            updateSelectedStatus(.claimed)
            phase = .qr
            persistDraft()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func acceptScannedQR(_ value: String) {
        guard let selectedTask, EvidenceProcessor.qrMatches(value: value, expectedHash: selectedTask.expectedQrHash) else {
            errorMessage = FieldProofError.qrMismatch.localizedDescription
            return
        }
        scannedQR = value
        errorMessage = nil
        phase = .evidence
        persistDraft()
    }

    func addEvidence(_ item: CapturedEvidence) {
        evidence.removeAll { $0.type == item.type }
        evidence.append(item)
        persistDraft()
    }

    func updatePayoutAccount(_ value: String) {
        payoutAccount = value
        persistDraft()
    }

    func updateVisibleDamage(_ value: Bool) {
        visibleDamage = value
        persistDraft()
    }

    func submit() async {
        guard let task = selectedTask, let scannedQR, evidence.count == 2 else {
            errorMessage = FieldProofError.incompleteEvidence.localizedDescription
            return
        }
        phase = .submission
        isLoading = true
        persistDraft()
        do {
            receiptEvents = try await service.submit(
                taskID: task.id,
                qrValue: scannedQR,
                evidence: evidence,
                visibleDamage: visibleDamage,
                idempotencyKey: submissionIdempotencyKey
            )
            updateSelectedStatus(.paid)
            isLoading = false
            phase = .result
            persistDraft()
        } catch {
            isLoading = false
            errorMessage = error.localizedDescription
            phase = .evidence
            persistDraft()
        }
    }

    func reset() {
        selectedTask = nil
        payoutAccount = ""
        scannedQR = nil
        evidence = []
        visibleDamage = false
        receiptEvents = []
        errorMessage = nil
        claimIdempotencyKey = UUID()
        submissionIdempotencyKey = UUID()
        phase = .tasks
        do {
            try draftStore.clear()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func isValidHederaAccount(_ value: String) -> Bool {
        value.wholeMatch(of: /0\.0\.[0-9]+/) != nil
    }

    private func updateSelectedStatus(_ status: TaskStatus) {
        selectedTask?.status = status
        guard let id = selectedTask?.id, let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        tasks[index].status = status
    }

    private func restoreDraft() {
        do {
            guard let draft = try draftStore.load() else { return }
            selectedTask = draft.selectedTask
            phase = draft.phase == .submission ? .evidence : draft.phase
            payoutAccount = draft.payoutAccount
            scannedQR = draft.scannedQR
            evidence = draft.evidence
            visibleDamage = draft.visibleDamage
            receiptEvents = draft.receiptEvents
            claimIdempotencyKey = draft.claimIdempotencyKey
            submissionIdempotencyKey = draft.submissionIdempotencyKey
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func persistDraft() {
        let draft = InspectionDraft(
            selectedTask: selectedTask,
            phase: phase,
            payoutAccount: payoutAccount,
            scannedQR: scannedQR,
            evidence: evidence,
            visibleDamage: visibleDamage,
            receiptEvents: receiptEvents,
            claimIdempotencyKey: claimIdempotencyKey,
            submissionIdempotencyKey: submissionIdempotencyKey
        )
        do {
            try draftStore.save(draft)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
