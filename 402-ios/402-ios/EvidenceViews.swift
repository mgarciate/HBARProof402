import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct QRStepView: View {
    @Bindable var model: AppModel
    @State private var scannerUnavailable = false

    var body: some View {
        VStack(spacing: 20) {
            VStack(spacing: 6) {
                Text("Scan the Asset")
                    .font(.title2.bold())
                Text("Confirm that the bicycle matches the task before taking photos.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }

#if canImport(UIKit)
            QRScannerView(
                onCode: { model.acceptScannedQR($0) },
                onUnavailable: { scannerUnavailable = true }
            )
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay {
                RoundedRectangle(cornerRadius: 20)
                    .stroke(.white.opacity(0.8), lineWidth: 2)
                    .padding(40)
                    .allowsHitTesting(false)
            }
#else
            ContentUnavailableView("Camera Unavailable", systemImage: "camera.fill")
#endif

            if scannerUnavailable {
                Label("The scanner is unavailable. You can continue with the demo QR code.", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Button("Use Demo QR") {
                if let assetID = model.selectedTask?.assetExternalId {
                    model.acceptScannedQR("FIELDPROOF:\(assetID)")
                }
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .navigationTitle("QR Code")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct EvidenceCaptureView: View {
    @Bindable var model: AppModel
    @State private var requestedType: CapturedEvidence.EvidenceType?
    @State private var showsConsent = false

    var body: some View {
        List {
            Section {
                Text("Take clear photos and avoid including faces, license plates, or other personal data.")
                    .font(.callout)
            }

            Section("Required Evidence") {
                evidenceRow(for: .assetOverview)
                evidenceRow(for: .componentDetail)
            }

            Section("Inspection") {
                Toggle(
                    "Visible Damage",
                    isOn: Binding(
                        get: { model.visibleDamage },
                        set: model.updateVisibleDamage
                    )
                )
            }

            Section {
                Button("Review and Submit") {
                    if model.evidence.count == 2 {
                        showsConsent = true
                    } else {
                        model.errorMessage = FieldProofError.incompleteEvidence.localizedDescription
                    }
                }
                .frame(maxWidth: .infinity)
                .disabled(model.evidence.count != 2)
            }
        }
        .navigationTitle("Capture Evidence")
#if canImport(UIKit)
        .sheet(item: $requestedType) { type in
            CameraPicker { image in
                do {
                    model.addEvidence(try EvidenceProcessor.process(image: image, type: type))
                } catch {
                    model.errorMessage = error.localizedDescription
                }
            }
            .ignoresSafeArea()
        }
#endif
        .confirmationDialog(
            "Submit This Evidence?",
            isPresented: $showsConsent,
            titleVisibility: .visible
        ) {
            Button("Submit 2 Photos") {
                Task { await model.submit() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Files are stored off-chain. Their hashes may be published permanently on Hedera.")
        }
    }

    private func evidenceRow(for type: CapturedEvidence.EvidenceType) -> some View {
        let evidence = model.evidence.first { $0.type == type }
        return Button {
            requestedType = type
        } label: {
            HStack(spacing: 14) {
                Image(systemName: evidence == nil ? type.systemImage : "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(evidence == nil ? Color.secondary : Color.mint)
                    .frame(width: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(type.title)
                        .foregroundStyle(.primary)
                    if let evidence {
                        Text(String(evidence.sha256.prefix(24)) + "…")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Tap to Open the Camera")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Image(systemName: "camera")
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityHint(evidence == nil ? "Opens the camera" : "Allows you to retake the photo")
    }
}
