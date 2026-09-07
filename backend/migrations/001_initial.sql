CREATE TABLE principals (
  id uuid PRIMARY KEY, role text NOT NULL CHECK (role IN ('agent','worker','operator')),
  token_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workers (
  id uuid PRIMARY KEY REFERENCES principals(id), payout_account_id text, verified_at timestamptz
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY, agent_id uuid NOT NULL REFERENCES principals(id),
  status text NOT NULL CHECK (status IN ('DRAFT','OPEN','CLAIMED','EVIDENCE_SUBMITTED','VERIFYING','APPROVED','REJECTED','MANUAL_REVIEW','PAID','CANCELLED','EXPIRED')),
  spec jsonb NOT NULL, spec_hash text NOT NULL, reward_tinybars bigint NOT NULL CHECK (reward_tinybars > 0),
  reserved boolean NOT NULL DEFAULT true, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_available ON tasks(status, expires_at);
CREATE TABLE claims (
  task_id uuid PRIMARY KEY REFERENCES tasks(id), worker_id uuid NOT NULL REFERENCES workers(id),
  payout_account_id text NOT NULL, claimed_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE uploads (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), worker_id uuid NOT NULL REFERENCES workers(id),
  type text NOT NULL CHECK (type IN ('asset_overview','component_detail')), sha256 text NOT NULL,
  byte_size integer NOT NULL, storage_key text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE evidence (
  task_id uuid PRIMARY KEY REFERENCES tasks(id), manifest jsonb NOT NULL, aggregate_hash text NOT NULL,
  exact_duplicate boolean NOT NULL, submitted_at timestamptz NOT NULL DEFAULT now(),
  delete_after timestamptz NOT NULL DEFAULT now() + interval '7 days', deleted_at timestamptz
);
CREATE TABLE evidence_files (
  task_id uuid NOT NULL REFERENCES evidence(task_id), type text NOT NULL,
  sha256 text NOT NULL, storage_key text NOT NULL UNIQUE, PRIMARY KEY(task_id,type)
);
CREATE INDEX evidence_hash_history ON evidence_files(sha256);
CREATE TABLE verifications (
  task_id uuid PRIMARY KEY REFERENCES tasks(id), operation_id uuid NOT NULL UNIQUE,
  mode text NOT NULL DEFAULT 'mock' CHECK (mode = 'mock'), scenario text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING', result jsonb, attempts integer NOT NULL DEFAULT 0,
  last_error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE economic_operations (
  id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),
  type text NOT NULL CHECK (type = 'WORKER_REWARD'), idempotency_key text NOT NULL UNIQUE,
  amount_tinybars bigint NOT NULL, recipient text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PREPARED','SUBMITTED','CONFIRMED','FAILED')),
  transaction_id text UNIQUE, signed_bytes bytea, last_error text, confirmed_at timestamptz
);
CREATE TABLE hcs_events (
  id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), type text NOT NULL,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'PENDING',
  transaction_id text UNIQUE, signed_bytes bytea, sequence bigint, consensus_timestamp text,
  last_error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id,type)
);
CREATE TABLE task_events (
  id bigserial PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id),
  type text NOT NULL, data jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency (
  principal_id uuid NOT NULL REFERENCES principals(id), scope text NOT NULL, key text NOT NULL,
  request_hash text NOT NULL, response_status integer NOT NULL, response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(principal_id,scope,key)
);
CREATE TABLE jobs (
  id bigserial PRIMARY KEY, kind text NOT NULL, task_id uuid REFERENCES tasks(id),
  dedupe_key text NOT NULL UNIQUE, payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(), last_error text, finished_at timestamptz
);
CREATE INDEX jobs_pending ON jobs(available_at) WHERE status = 'PENDING';
