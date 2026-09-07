-- Existing tasks retain their free mock workflow and original on-chain commitments.
ALTER TABLE tasks ADD COLUMN verification_payment_mode text NOT NULL DEFAULT 'free_mock'
  CHECK (verification_payment_mode IN ('free_mock','x402'));
CREATE TABLE verification_payments (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),
  verification_id uuid NOT NULL UNIQUE REFERENCES verifications(operation_id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  evidence_hash text NOT NULL,
  requirements jsonb NOT NULL,
  resource jsonb NOT NULL,
  facilitator_url text NOT NULL,
  amount_tinybars bigint NOT NULL CHECK (amount_tinybars>0),
  recipient text NOT NULL,
  status text NOT NULL DEFAULT 'QUOTED' CHECK (status IN ('QUOTED','AUTHORIZED','SETTLING','CONFIRMED','FAILED','UNKNOWN')),
  payment_payload jsonb,
  authorization_hash text,
  transaction_id text UNIQUE,
  payer text,
  settlement jsonb,
  quoted_until timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CHECK ((payment_payload IS NULL AND transaction_id IS NULL AND payer IS NULL AND status='QUOTED') OR
         (payment_payload IS NOT NULL AND transaction_id IS NOT NULL AND payer IS NOT NULL AND status<>'QUOTED'))
);
CREATE TABLE verification_payment_keys (
  principal_id uuid NOT NULL REFERENCES principals(id),
  key text NOT NULL,
  request_hash text NOT NULL,
  payment_id uuid NOT NULL REFERENCES verification_payments(id),
  PRIMARY KEY (principal_id,key)
);
