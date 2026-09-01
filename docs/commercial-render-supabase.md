# FileFinder on Render and Supabase

## Initial commercial topology

```text
Customer desktop + Rust agent
        |
        | outbound HTTPS and WSS on port 443
        v
Render managed TLS and load balancer
        |
        v
FileFinder Fastify coordinator (one paid Render web instance)
        |
        | secret PostgreSQL connection
        v
Supabase Postgres through Supavisor session mode
```

This uses Render's native Node runtime. It does not require Docker, Caddy,
WireGuard, customer router configuration, or a public IP on customer computers.

## Supabase connection

FileFinder is a persistent backend, so use Supabase **Session pooler** URIs from
Dashboard > Connect. Session mode uses port 5432 and works from IPv4 networks.
Do not use transaction mode for this persistent Node service.

Use two separate connection strings:

- `MIGRATION_DATABASE_URL`: the `postgres`/admin Session pooler URI, used only by
  Render's pre-deploy migration command.
- `DATABASE_URL`: the custom `filefinder_app` Session pooler URI used by the
  running coordinator. Its pooler username is
  `filefinder_app.<project-ref>`.

Do not put the database password, connection string, service-role key, or secret
key in the Tauri application. The desktop communicates only with Render.

The coordinator uses direct SQL and does not need the Supabase Data API. Disable
the Data API for this project where possible. Otherwise, deny `anon` and
`authenticated` access and enable RLS on every FileFinder table in the exposed
`public` schema. Apply and verify those database controls through a reviewed
Supabase migration before production data is stored.

For initial setup, run migrations with the admin connection, then run
`operations/supabase/provision-filefinder-role.sql` in the Supabase SQL Editor
after replacing its password placeholder. The runtime role is not a superuser,
cannot create databases or roles, and can access only FileFinder application
tables. If a future migration adds a table, grant it deliberately; new tables
are denied by default.

## Render configuration

The root `render.yaml` creates one native Node web service. Before its first
deployment, provide these secret values in Render:

- `DATABASE_URL`: custom `filefinder_app` Session pooler connection string.
- `MIGRATION_DATABASE_URL`: admin Session pooler connection string.
- `COMMAND_SIGNING_PRIVATE_KEY`: output from `pnpm generate:signing-key`.

Render generates the JWT and initial bootstrap secrets. Use the service's
`onrender.com` address only for development. Attach a product-owned domain before
shipping the commercial desktop application.

## Device authentication on Render

Render terminates TLS at its edge, so the coordinator cannot depend on the
Caddy-provided mTLS fingerprint header. Every device instead generates its own
Ed25519 identity during enrolment. The private key and high-entropy agent token
are protected by Windows DPAPI; only the public key is sent to the coordinator.
Every agent HTTP request and WebSocket handshake carries a timestamp, unique
nonce, and Ed25519 signature. The coordinator rejects expired signatures and
replayed nonces in addition to checking the revocable device token.

No universal installer should contain a pre-generated customer private key.

## Scaling

Start with one coordinator instance. Its WebSocket map currently lives in memory.
Before increasing Render `numInstances`, add Render Key Value (Valkey) for
presence TTLs and command pub/sub so any instance can reach any connected agent.
PostgreSQL remains the durable source of truth.

## Production release gates

- Paid Render web service; free services can sleep and are not production-ready.
- Paid Supabase project with backups and a tested restore procedure.
- Supabase Data API disabled or grants/RLS verified for every FileFinder table.
- Device proof-of-possession enforced on HTTP and WebSocket routes (implemented;
  keep the integration test as a release gate).
- Login and enrolment rate limits.
- Tenant isolation tests on every user and device route.
- Authenticode-signed desktop installer and updater.
- Production domain, monitoring, alerts, privacy controls, and incident process.
