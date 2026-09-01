import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("PostgreSQL coordinator flow", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const signingKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const config: Config = {
    NODE_ENV: "test", HOST: "127.0.0.1", PORT: 7443, TRUST_PROXY: false, DATABASE_URL: databaseUrl!,
    DATABASE_POOL_MAX: 2, DATABASE_IDLE_TIMEOUT_MS: 30000, DATABASE_CONNECT_TIMEOUT_MS: 10000,
    JWT_SECRET: "integration-jwt-secret-with-at-least-32-characters",
    BOOTSTRAP_TOKEN: "integration-bootstrap-token-long-enough",
    COMMAND_SIGNING_PRIVATE_KEY: signingKey,
    UI_ORIGINS: "https://tauri.localhost",
    REQUIRE_AGENT_SIGNATURES: false,
    REQUIRE_AGENT_CERTIFICATE: false
  };
  const server = createServer(config, pool);

  beforeAll(async () => {
    await migrate(pool);
    await pool.query("TRUNCATE organisations CASCADE");
    await server.ready();
  });

  afterAll(async () => { await server.close(); await pool.end(); });

  it("converges enrolment, ingestion, search, command and revocation safely", async () => {
    const bootstrap = await server.inject({ method: "POST", url: "/api/v1/auth/bootstrap", payload: {
      organisationName: "Integration Office", email: "admin@example.test", password: "correct horse battery staple", bootstrapToken: config.BOOTSTRAP_TOKEN
    }});
    expect(bootstrap.statusCode).toBe(201);
    const accessToken = bootstrap.json().accessToken as string;
    const auth = { authorization: `Bearer ${accessToken}` };

    const enrolment = await server.inject({ method: "POST", url: "/api/v1/enrolments", headers: auth, payload: { expiresInMinutes: 30 } });
    expect(enrolment.statusCode).toBe(201);
    const enrolled = await server.inject({ method: "POST", url: "/api/v1/devices/enrol", payload: {
      code: enrolment.json().code, name: "PC-01", os: "Windows 11", publicKey: "integration-device-public-key-00000001"
    }});
    expect(enrolled.statusCode).toBe(201);
    const { deviceId, agentToken } = enrolled.json() as { deviceId: string; agentToken: string };
    const agentAuth = { authorization: `Bearer ${agentToken}` };

    const root = await server.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/roots`, headers: auth, payload: { canonicalPath: "D:\\Projects" } });
    expect(root.statusCode).toBe(201);
    const rootId = root.json().id as string;
    const eventId = randomUUID();
    const event = { eventId, sequence: 1, operation: "UPSERT", rootId, stableFileId: "volume:file-1", name: "project_report.pdf", relativePath: "Reports/project_report.pdf", extension: "pdf", sizeBytes: 481280, modifiedAt: new Date().toISOString() };
    expect((await server.inject({ method: "POST", url: "/api/v1/agent/events/batch", headers: agentAuth, payload: { events: [event] } })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: "/api/v1/agent/events/batch", headers: agentAuth, payload: { events: [{ ...event, eventId: randomUUID() }] } })).statusCode).toBe(409);

    await server.inject({ method: "POST", url: "/api/v1/agent/heartbeat", headers: agentAuth });
    const search = await server.inject({ method: "GET", url: "/api/v1/files/search?q=project_report", headers: auth });
    expect(search.statusCode).toBe(200);
    expect(search.json().items[0].name).toBe("project_report.pdf");
    const fileId = search.json().items[0].id as string;
    expect((await server.inject({ method: "POST", url: "/api/v1/commands", headers: auth, payload: { fileId, type: "REVEAL_FILE" } })).statusCode).toBe(201);

    expect((await server.inject({ method: "PATCH", url: `/api/v1/devices/${deviceId}`, headers: auth, payload: { state: "REVOKED" } })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: "/api/v1/agent/heartbeat", headers: agentAuth })).statusCode).toBe(401);
  });
});
