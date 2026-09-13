# FieldProof402 for iOS

FieldProof402 is a SwiftUI client for completing paid field-verification tasks on Hedera testnet. A worker claims a task, identifies the physical asset by QR code, captures the required evidence, and submits it to the FieldProof402 backend. The app then presents the resulting verification and reward receipt.

The iOS app does not hold a worker's Hedera private key and does not publish private photographs on-chain. Evidence files are uploaded to private object storage; their SHA-256 hashes can be included in the permanent Hedera audit trail.

## Features

- Fetches available FieldProof402 tasks from the marketplace API.
- Registers a public Hedera testnet payout account and claims a task.
- Scans asset QR codes and validates them against the task's expected hash.
- Captures an asset overview and component-detail photograph.
- Computes deterministic SHA-256 evidence hashes on-device.
- Uploads photographs directly through backend-provided signed URLs.
- Uses stable idempotency keys for claim and evidence submission retries.
- Persists an in-progress inspection with iOS complete file protection.
- Displays verification, HCS, x402, reward, and HashScan receipt events returned by the backend.
- Supports Dynamic Type and VoiceOver-friendly labels throughout the main flow.

## Inspection flow

```text
Available task
    -> Hedera payout account
    -> Task claim
    -> Asset QR validation
    -> Evidence capture
    -> Private upload and evidence submission
    -> Verification and reward receipt
```

## Technology

- Swift and SwiftUI
- Structured concurrency with `async`/`await`
- Observation with `@Observable`
- VisionKit for QR scanning
- CryptoKit for SHA-256 hashing
- URLSession for marketplace and signed-upload requests
- Swift Testing for unit tests

The project has no third-party iOS dependencies.

## Requirements

- macOS with Xcode 26 or later
- iOS 26 or later
- A running [FieldProof402 backend](../backend/README.md)
- A backend-issued worker bearer token
- A public Hedera testnet account ID in `0.0.x` format
- A physical iPhone is recommended for QR scanning and camera capture

The simulator can use the photo library when a camera is unavailable. The **Use Demo QR** button submits `FIELDPROOF:<assetExternalId>` and only succeeds when the task was created with the matching QR hash.

## Getting started

1. Start and seed the backend by following its [local setup instructions](../backend/README.md#run-locally).
2. Open `402-ios.xcodeproj` in Xcode.
3. Select **Product > Scheme > Edit Scheme > Run > Arguments**.
4. Add the configuration values below under **Environment Variables**.
5. Select the `402-ios` scheme and an iOS device or simulator.
6. Build and run with **Command-R**.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FIELDPROOF_API_BASE_URL` | No | `http://127.0.0.1:3000` | Marketplace API origin. |
| `FIELDPROOF_WORKER_ID` | No | `worker_ios_demo` | Worker principal seeded by the backend. |
| `WORKER_API_TOKEN` | Yes for authenticated APIs | None | Bearer token issued for the worker principal. |

Example values are provided in [`.env.example`](.env.example), but Xcode does not automatically load that file. Add values to an unshared local scheme as described above. See [CONFIGURATION.md](CONFIGURATION.md) for additional configuration guidance.

### Connecting from a physical device

`127.0.0.1` on an iPhone refers to the iPhone itself. When running the backend on your Mac, set `FIELDPROOF_API_BASE_URL` to an address the phone can reach, such as `http://192.168.1.20:3000`. The backend's public object-storage endpoint must also be reachable from the phone because the app uploads evidence directly to its signed URLs.

For a deployed backend, use HTTPS. Local HTTP development may also require an appropriate App Transport Security exception, depending on the address and Xcode configuration.

## Backend interaction

The app uses the following mobile workflow:

| Step | Request |
| --- | --- |
| List tasks | `GET /v1/tasks?status=OPEN` |
| Set payout account | `PUT /v1/workers/{workerId}/payout-account` |
| Claim task | `POST /v1/tasks/{taskId}/claim` |
| Prepare uploads | `POST /v1/tasks/{taskId}/evidence/uploads` |
| Upload evidence | `PUT` to each signed object-storage URL |
| Submit evidence | `POST /v1/tasks/{taskId}/evidence` |
| Verify receipt | `GET /v1/tasks/{taskId}/receipt/verify` |

Marketplace requests include the worker bearer token. Signed object-storage uploads deliberately do not receive that token. Claim and evidence submission requests carry an `Idempotency-Key` header, and those keys survive app restarts while an inspection is in progress.

## Testing

Run the test suite in Xcode with **Product > Test** or **Command-U**. From the command line, with a suitable simulator installed:

```bash
xcodebuild test \
  -project 402-ios.xcodeproj \
  -scheme 402-ios \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

The tests cover QR and evidence hashing, protected draft persistence, transient HTTP retry behavior, authorization-header isolation for signed uploads, and idempotency-key reuse after a failed claim and app restart.

## Project structure

```text
402-ios/
├── 402-ios/
│   ├── AppConfiguration.swift   Runtime configuration
│   ├── APIClient.swift          HTTP transport and retry behavior
│   ├── AppModel.swift           Observable application state and flow
│   ├── FieldProofService.swift  Marketplace API workflow
│   ├── EvidenceProcessor.swift  JPEG processing and SHA-256 hashes
│   ├── DraftStore.swift         Protected local draft persistence
│   └── *Views.swift             SwiftUI task, capture, and result screens
├── FieldProofTests/             Unit tests
├── CONFIGURATION.md             Local configuration details
└── 402-ios.xcodeproj            Xcode project
```

## Privacy and security

- Enter only a public Hedera account ID; the app never needs a private key or seed phrase.
- Avoid capturing faces, license plates, or other personal information in evidence.
- Photographs remain off-chain, while hashes and receipt data may be permanent.
- Keep `WORKER_API_TOKEN` out of source control, shared schemes, logs, and `Info.plist`.
- Production session credentials should be stored in Keychain.

## Current scope

This repository is the worker-facing iOS client. Hedera transactions, HCS publication, x402 verification purchases, reward settlement, and receipt verification are performed by the backend. The backend's current visual analysis is explicitly mock; successful UI and test runs do not by themselves prove a real Hedera transfer. See the [backend README](../backend/README.md) for its testnet setup, operational model, and end-to-end acceptance criteria.
