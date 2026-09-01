import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const production = {
  NODE_ENV: "production",
  HOST: "0.0.0.0",
  PORT: "10000",
  TRUST_PROXY: "true",
  DATABASE_URL: "postgresql://postgres.project:secret@region.pooler.supabase.com:5432/postgres?sslmode=require",
  JWT_SECRET: "a-production-secret-that-is-long-and-random-123456",
  BOOTSTRAP_TOKEN: "a-production-bootstrap-token-that-is-random",
  COMMAND_SIGNING_PRIVATE_KEY: "a".repeat(64),
  UI_ORIGINS: "https://tauri.localhost,tauri://localhost",
  REQUIRE_AGENT_SIGNATURES: "true",
  REQUIRE_AGENT_CERTIFICATE: "false"
};

describe("production configuration", () => {
  it("accepts a Render and Supabase configuration", () => {
    const config = loadConfig(production);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.REQUIRE_AGENT_CERTIFICATE).toBe(false);
  });

  it("rejects placeholder secrets", () => {
    expect(() => loadConfig({ ...production, JWT_SECRET: "replace-this-with-a-long-production-secret" })).toThrow();
  });

  it("rejects insecure production UI origins", () => {
    expect(() => loadConfig({ ...production, UI_ORIGINS: "http://example.com" })).toThrow();
  });
});
