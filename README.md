# FileFinder

Windows-first, self-hosted metadata search across office LAN and private-VPN connected computers. File contents are never uploaded or transferred.

## Implemented

- PostgreSQL schema and migrations for organisations, users, devices, indexed roots, files, ordered agent events and audit history.
- Fastify/TypeScript coordinator with Argon2id accounts, rotating refresh sessions, administration and audit history.
- Admin-created, single-use device enrolment codes and revocable device tokens.
- Explicit indexed-root registration, ordered idempotent metadata ingestion and tombstones.
- Filename/path search with device and extension filters.
- Heartbeat-based online/stale/offline presence, device listing and device pause/revocation endpoints.
- Bounded reconciliation snapshots that repair missed watcher events and tombstone absent files atomically on completion.
- Rust Windows agent with bounded scanning, filesystem watching, a durable SQLite WAL journal, ordered retry and reconciliation.
- mTLS agent transport, WebSocket notifications with polling fallback, Ed25519 command signatures and local replay prevention.
- Canonical root containment checks and fixed Windows Explorer reveal/open invocation without arbitrary shell commands.
- Tauri 2 + React desktop search, devices, connection status and administrator-led local agent enrolment.
- Neutral, offline-capable interface with no public font or asset dependency.
- Windows NSIS/MSI configuration, coordinator service scripts, PKI issuance, encrypted backups, restore and guarded upgrades.
- Unit, HTTP contract and optional PostgreSQL end-to-end/load test harnesses.

## Repository

- `src`, `db`, `scripts`: coordinator, migrations and test/load utilities.
- `agent`: reusable Rust agent core and tray-process executable.
- `desktop`: Tauri/React desktop application.
- `operations`: Windows service, PKI, TLS proxy, backup, restore and upgrade scripts.
- `output/pdf`: product and delivery plan.

## Run locally

1. Copy `.env.example` to `.env`, replace all secrets and generate the Ed25519 key with `pnpm generate:signing-key`.
2. Start PostgreSQL with `docker compose up -d postgres`.
3. Install dependencies with `pnpm install`.
4. Apply the schema with `pnpm migrate`.
5. Start the API with `pnpm dev`.

The API listens on loopback port `7443`; Caddy exposes separate user and mTLS-only agent hostnames. Check `GET /healthz` and `GET /readyz` before bootstrapping the first admin.

## Verify

- `pnpm test`: coordinator unit and HTTP contract tests.
- `TEST_DATABASE_URL=... pnpm test:integration`: real migration and end-to-end PostgreSQL flow.
- `LOAD_RECORDS=100000 TEST_DATABASE_URL=... pnpm test:load`: generated metadata/search benchmark, up to two million rows.
- `cargo test -p filefinder-agent`: scanner, containment and agent tests.
- `pnpm --filter @filefinder/desktop build`: frontend typecheck and production bundle.

This Linux workspace cannot finish-link the Tauri shell because WebKitGTK is absent. The release target is Windows WebView2; `.github/workflows/ci.yml` builds and tests the agent and NSIS/MSI bundles on Windows.

## Windows Release

Run `scripts/Prepare-WindowsDesktopRelease.ps1` on a Windows signing host. It builds the Rust sidecar, stages the target-qualified binary, creates NSIS/MSI bundles and optionally signs them when `WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT` is set.

Run `scripts/Prepare-WindowsCoordinatorRelease.ps1` to stage a coordinator release containing its own Node runtime, production dependencies, migrations and operations scripts. Employee desktops do not require Node.js, Rust, SDKs or Docker.

## UI Direction

The desktop uses a 95% neutral visual palette: near-white surfaces, graphite text, muted gray borders and restrained online/warning accents only.
