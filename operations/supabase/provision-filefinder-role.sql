-- Run this once in the Supabase SQL Editor after replacing the password below.
-- Keep that password only in Render's DATABASE_URL. Never ship it to a client.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'filefinder_app') THEN
    CREATE ROLE filefinder_app LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD'
      NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE filefinder_app NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE postgres TO filefinder_app;
GRANT USAGE ON SCHEMA public TO filefinder_app;
GRANT USAGE ON SCHEMA extensions TO filefinder_app;

GRANT SELECT, INSERT, UPDATE ON
  schema_migrations,
  organisations,
  users,
  refresh_sessions,
  enrolments,
  devices,
  device_tokens,
  indexed_roots,
  files,
  agent_events,
  audit_log,
  reconciliation_sessions,
  reconciliation_entries,
  device_commands
TO filefinder_app;

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO filefinder_app;

DO $$
DECLARE
  table_name text;
  policy_name text := 'filefinder_coordinator_access';
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'schema_migrations', 'organisations', 'users', 'refresh_sessions', 'enrolments', 'devices',
    'device_tokens', 'indexed_roots', 'files', 'agent_events', 'audit_log',
    'reconciliation_sessions', 'reconciliation_entries', 'device_commands'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = table_name AND policyname = policy_name
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO filefinder_app USING (true) WITH CHECK (true)',
        policy_name,
        table_name
      );
    END IF;
  END LOOP;
END
$$;

-- The schema was applied through the Supabase migration API. Seed the
-- coordinator's own migration ledger so Render's pre-deploy check stays
-- idempotent while using the least-privilege runtime role.
INSERT INTO schema_migrations (name) VALUES
  ('001_initial.sql'),
  ('002_sessions_presence_reconciliation.sql'),
  ('003_device_commands.sql'),
  ('004_device_certificate_binding.sql'),
  ('004_supabase_api_lockdown.sql'),
  ('005_public_schema_hardening.sql'),
  ('006_supabase_advisor_hardening.sql')
ON CONFLICT (name) DO NOTHING;
