# Mobile API contract

The backend does not change `../402-ios`. Replace `MockFieldProofService` with a URLSession implementation using the API described here. The API is documented live at `/docs` and `/docs/json`.

All `/v1` calls need `Authorization: Bearer <role-token>`. Obtain the worker ID with `GET /v1/me`. All POST/PUT calls need a persistent `Idempotency-Key` (8–200 characters) and JSON body; send `{}` for claim/cancel/retry. Preserve the same key and exact body after a network error. Use a new key after correcting a rejected request or intentionally requesting new upload URLs.

## Endpoints

| Endpoint | Role / behavior |
| --- | --- |
| `POST /v1/tasks` | Agent; 202 with `id`, `DRAFT`, `taskSpecHash` until HCS confirms |
| `GET /v1/tasks?status=OPEN&limit=25&cursor=<uuid>` | Authenticated; `{tasks,nextCursor}`; public discovery summaries and own tasks |
| `GET /v1/tasks/{id}` | Discovery summary while available; private detail for owner/claim/operator |
| `PUT /v1/workers/{id}/payout-account` | Own worker; `{hederaAccountId:"0.0.123"}` |
| `POST /v1/tasks/{id}/claim` | Worker; 200 with snapshotted payout account and expiry |
| `POST /v1/tasks/{id}/cancel` | Owner agent; open/unexpired task only |
| `POST /v1/tasks/{id}/evidence/uploads` | Claiming worker; 201 with two signed PUT instructions |
| `POST /v1/tasks/{id}/evidence` | Claiming worker; 202 with aggregate hash and mock flags |
| `GET /v1/tasks/{id}/result` | Owner/claim/operator; 202 operational state or 200 versioned result |
| `GET /v1/tasks/{id}/events?cursor=0&limit=50` | Owner/claim/operator; `{events,nextCursor}`; IDs/cursors are decimal strings |
| `GET /v1/tasks/{id}/receipt/verify` | Owner/claim/operator; checks against S3 and Mirror Node |
| `POST /v1/x402/verify` | Owner agent; `{taskId}`; 402 challenge, then 202 after signed authorization |
| `GET /v1/x402/payments/{paymentId}` | Owner/claim/operator; safe purchase status and transaction reference |

The requesting agent, not the collaborator's iPhone/Watch, purchases verification using [the x402 flow](x402.md). No callback is required. The Watch asks iPhone to claim; only a backend 200 confirms success. Declining a task in Watch is a local dismissal, not global cancellation.

## Mapping from the current Swift mock

| Current Swift model | Backend wire value |
| --- | --- |
| `expectedQrValue` | Private `expectedQrHash`; hash scanned text locally and compare after claim |
| `rewardAmount: Decimal` | `reward: {asset:"HBAR", amount:"5"}`; parse decimal string |
| Human-readable evidence enum | `asset_overview`, `component_detail` |
| `submit(...) -> [ReceiptEvent]` | Submit returns 202; poll task/result/events and build presentation locally |
| Eight status cases | Add `DRAFT`, `EXPIRED`, `CANCELLED` |
| UUID receipt IDs | Cursor event IDs are strings; derive local UI identifiers if needed |

Use ISO-8601 with fractional seconds support and UTC. Never decode HBAR amounts as floating-point numbers. Task/event `id` and `taskId` values are UUID strings. Poll every three seconds while awaiting HCS, verification or reward; back off on 429/503.

## Upload and submit examples

Request uploads after sanitizing **two JPEGs**, each at most 10 MiB and 25 megapixels:

```json
{
  "files": [
    {"type":"asset_overview","sha256":"sha256:<64 lowercase hex>","contentType":"image/jpeg","size":12345},
    {"type":"component_detail","sha256":"sha256:<64 lowercase hex>","contentType":"image/jpeg","size":23456}
  ]
}
```

Each response file has `uploadId`, `type`, `method: "PUT"`, `url`, `headers` and `expiresAt`. PUT raw bytes using those headers; do not attach the marketplace token to S3. The app must preserve the sanitized bytes and hashes across retries. If a URL expires, request a new upload batch with a new idempotency key.

```json
{
  "qrHash":"sha256:<SHA-256 of exact QR UTF-8 text>",
  "consent":true,
  "answers":{"visibleDamage":true},
  "files":[
    {"type":"asset_overview","uploadId":"<uuid>","sha256":"sha256:<64 lowercase hex>"},
    {"type":"component_detail","uploadId":"<uuid>","sha256":"sha256:<64 lowercase hex>"}
  ]
}
```

Missing/invalid files return 400 and keep the claim editable; expired tasks return 409. A wrong QR submitted to the backend is a verification rejection, not a technical failure. `visibleDamage: true` alone does not reject a valid inspection.

Result fields: `taskId`, `status`, `checks`, `verifierVersion`, `verificationMode: "mock"`, `x402PaymentReference` (confirmed Hedera transaction ID for paid verification, otherwise null), `evidenceAggregateHash`. Task summaries expose immutable `verificationPaymentMode` (`x402` or `free_mock`); private detail also exposes `verificationPayment` and `x402PaymentStatus`. Show payment waiting separately from mock analysis. Paid tasks remain `EVIDENCE_SUBMITTED` until settlement, then become `VERIFYING`. `MANUAL_REVIEW` has no reward. Operational failures are not verification rejections.

Errors use `{error:{code,message,requestId}}`. Important codes: `UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `INVALID_STATE`, `TASK_EXPIRED`, `PAYOUT_ACCOUNT_REQUIRED`, `ACCOUNT_NOT_FOUND`, `IDEMPOTENCY_CONFLICT`, `HASH_MISMATCH`, `INVALID_IMAGE`, `INSUFFICIENT_REWARD_BUDGET`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`.

Receipt responses expose per-event indexing/verification states, real transaction IDs and HashScan links. `verified_mock_flow` confirms the audit/payment workflow with a mock decision; it never claims physical authenticity. Inspect `checks.x402` for the independent purchase check (`not_performed` for free/legacy tasks) and `checks.reward` for the collaborator's payment. After retention, `filesAvailable:false` and `fileHashes:deleted_by_retention` preserve the distinction between checking the committed manifest and checking retained bytes.
