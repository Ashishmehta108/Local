CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION pg_trgm SET SCHEMA extensions;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'filefinder_app') THEN
    GRANT USAGE ON SCHEMA extensions TO filefinder_app;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS device_commands_file_idx ON device_commands (file_id);
CREATE INDEX IF NOT EXISTS device_commands_requested_by_idx ON device_commands (requested_by);
CREATE INDEX IF NOT EXISTS enrolments_created_by_idx ON enrolments (created_by);
CREATE INDEX IF NOT EXISTS enrolments_organisation_idx ON enrolments (organisation_id);
CREATE INDEX IF NOT EXISTS files_root_idx ON files (root_id);
CREATE INDEX IF NOT EXISTS indexed_roots_organisation_idx ON indexed_roots (organisation_id);
CREATE INDEX IF NOT EXISTS reconciliation_sessions_device_idx ON reconciliation_sessions (device_id);
CREATE INDEX IF NOT EXISTS reconciliation_sessions_organisation_idx ON reconciliation_sessions (organisation_id);
CREATE INDEX IF NOT EXISTS refresh_sessions_replaced_by_idx ON refresh_sessions (replaced_by_id)
  WHERE replaced_by_id IS NOT NULL;
