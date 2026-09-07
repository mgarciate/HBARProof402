CREATE TABLE private_objects (
  storage_key text PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
