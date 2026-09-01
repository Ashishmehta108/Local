import type { Pool } from "pg";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const signingPrivateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

const config: Config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 7443,
  TRUST_PROXY: false,
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:5432/unused",
  DATABASE_POOL_MAX: 2,
  DATABASE_IDLE_TIMEOUT_MS: 30000,
  DATABASE_CONNECT_TIMEOUT_MS: 10000,
  JWT_SECRET: "test-jwt-secret-that-is-at-least-32-characters",
  BOOTSTRAP_TOKEN: "test-bootstrap-token-that-is-long-enough",
  COMMAND_SIGNING_PRIVATE_KEY: signingPrivateKey,
  UI_ORIGINS: "https://tauri.localhost,http://localhost:1420",
  REQUIRE_AGENT_SIGNATURES: false,
  REQUIRE_AGENT_CERTIFICATE: false
};

const pool = {
  query: async () => {
    throw new Error("Database should not be reached by this test.");
  }
} as unknown as Pool;

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("HTTP error contract", () => {
  it("returns 400 for a malformed bootstrap request", async () => {
    const server = createServer(config, pool);
    servers.push(server);
    const response = await server.inject({ method: "POST", url: "/api/v1/auth/bootstrap", payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("returns 401 before querying the database for a protected route", async () => {
    const server = createServer(config, pool);
    servers.push(server);
    const response = await server.inject({ method: "GET", url: "/api/v1/devices" });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("REQUEST_REJECTED");
  });

  it("binds an agent token to the reverse-proxy certificate fingerprint", async () => {
    const fingerprint = "a".repeat(64);
    const certificatePool = {
      query: async (sql: string) => sql.includes("FROM device_tokens")
        ? { rows: [{ deviceId: "device-1", organisationId: "org-1", state: "ACTIVE", certificateFingerprint: fingerprint }] }
        : { rows: [], rowCount: 1 }
    } as unknown as Pool;
    const server = createServer({ ...config, REQUIRE_AGENT_CERTIFICATE: true }, certificatePool);
    servers.push(server);

    const missing = await server.inject({ method: "POST", url: "/api/v1/agent/heartbeat", headers: { authorization: "Bearer valid-looking-device-token-0000000000" } });
    expect(missing.statusCode).toBe(401);
    const matching = await server.inject({ method: "POST", url: "/api/v1/agent/heartbeat", headers: {
      authorization: "Bearer valid-looking-device-token-0000000000", "x-filefinder-client-fingerprint": fingerprint
    }});
    expect(matching.statusCode).toBe(200);
  });

  it("requires a fresh signature from the enrolled device key", async () => {
    const deviceKey = generateKeyPairSync("ed25519");
    const publicKey = deviceKey.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const signaturePool = {
      query: async (sql: string) => sql.includes("FROM device_tokens")
        ? { rows: [{ deviceId: "device-1", organisationId: "org-1", state: "ACTIVE", certificateFingerprint: null, publicKey }] }
        : { rows: [], rowCount: 1 }
    } as unknown as Pool;
    const server = createServer({ ...config, REQUIRE_AGENT_SIGNATURES: true }, signaturePool);
    servers.push(server);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const message = `${timestamp}\n${nonce}\nPOST\n/api/v1/agent/heartbeat`;
    const signature = sign(null, Buffer.from(message), deviceKey.privateKey).toString("base64");
    const request = {
      method: "POST" as const,
      url: "/api/v1/agent/heartbeat",
      headers: {
        authorization: "Bearer valid-looking-device-token-0000000000",
        "x-filefinder-timestamp": timestamp,
        "x-filefinder-nonce": nonce,
        "x-filefinder-signature": signature
      }
    };

    const accepted = await server.inject(request);
    expect(accepted.statusCode).toBe(200);
    const replayed = await server.inject(request);
    expect(replayed.statusCode).toBe(401);
  });
});
