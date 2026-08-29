CREATE TYPE device_command_type AS ENUM ('REVEAL_FILE', 'OPEN_FILE');
CREATE TYPE device_command_status AS ENUM ('PENDING', 'DELIVERED', 'SUCCEEDED', 'FAILED', 'EXPIRED');

CREATE TABLE device_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  type device_command_type NOT NULL,
  status device_command_status NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  completed_at timestamptz,
  outcome_code text,
  outcome_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_commands_delivery_idx
  ON device_commands (device_id, status, expires_at, created_at);

CREATE INDEX device_commands_org_created_idx
  ON device_commands (organisation_id, created_at DESC);

