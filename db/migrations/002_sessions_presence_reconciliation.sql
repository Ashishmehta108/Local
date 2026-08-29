ALTER TABLE refresh_sessions
  ADD COLUMN replaced_by_id uuid REFERENCES refresh_sessions(id),
  ADD COLUMN last_used_at timestamptz;

CREATE INDEX refresh_sessions_user_active_idx
  ON refresh_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TYPE reconciliation_state AS ENUM ('UPLOADING', 'COMPLETED', 'CANCELLED');

CREATE TABLE reconciliation_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  root_id uuid NOT NULL REFERENCES indexed_roots(id) ON DELETE CASCADE,
  state reconciliation_state NOT NULL DEFAULT 'UPLOADING',
  entry_count bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX reconciliation_one_upload_per_root_idx
  ON reconciliation_sessions (root_id)
  WHERE state = 'UPLOADING';

CREATE TABLE reconciliation_entries (
  session_id uuid NOT NULL REFERENCES reconciliation_sessions(id) ON DELETE CASCADE,
  stable_file_id text NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  relative_path text NOT NULL,
  normalized_relative_path text NOT NULL,
  extension text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  modified_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, stable_file_id)
);

