import SwiftUI

struct SubmissionProgressView: View {
    var body: some View {
        VStack(spacing: 24) {
            ProgressView()
                .controlSize(.large)
            VStack(spacing: 8) {
                Text("Securing and Submitting")
                    .font(.title2.bold())
                Text("Uploading private evidence and waiting for the x402 verifier result.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 12) {
                Label("Metadata Removed", systemImage: "checkmark.circle.fill")
                Label("SHA-256 Hashes Calculated", systemImage: "checkmark.circle.fill")
                Label("Verification in Progress", systemImage: "hourglass")
            }
            .foregroundStyle(.mint)
        }
        .padding(32)
        .navigationBarBackButtonHidden()
        .accessibilityElement(children: .combine)
    }
}

struct TaskResultView: View {
    @Bindable var model: AppModel

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 72))
                    .foregroundStyle(.mint)
                    .accessibilityHidden(true)

                VStack(spacing: 8) {
                    Text("Inspection Approved")
                        .font(.largeTitle.bold())
                        .multilineTextAlignment(.center)
                    Text("The 5 HBAR reward is confirmed.")
                        .foregroundStyle(.secondary)
                }

                ReceiptTimelineView(events: model.receiptEvents)

                Button("Back to Tasks") {
                    model.reset()
                    Task { await model.loadTasks() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.mint)
            }
            .padding()
        }
        .navigationTitle("Result")
        .navigationBarBackButtonHidden()
    }
}

struct ReceiptTimelineView: View {
    let events: [ReceiptEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Verifiable Receipt")
                .font(.headline)
                .padding(.bottom, 16)

            ForEach(events) { event in
                HStack(alignment: .top, spacing: 14) {
                    VStack(spacing: 0) {
                        Image(systemName: event.systemImage)
                            .frame(width: 28, height: 28)
                            .foregroundStyle(.mint)
                        if event.id != events.last?.id {
                            Rectangle()
                                .fill(.quaternary)
                                .frame(width: 2, height: 46)
                        }
                    }

                    VStack(alignment: .leading, spacing: 3) {
                        Text(event.title).font(.subheadline.bold())
                        Text(event.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(event.date, style: .time)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        if let url = event.externalURL {
                            Link("Open in HashScan", destination: url)
                                .font(.caption.bold())
                                .padding(.top, 2)
                        }
                    }
                    Spacer()
                }
            }
        }
        .padding()
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }
}
