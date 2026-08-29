import { z } from "zod";

const environment = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(7443),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  BOOTSTRAP_TOKEN: z.string().min(24),
  COMMAND_SIGNING_PRIVATE_KEY: z.string().min(64),
  UI_ORIGINS: z.string().default("https://tauri.localhost,tauri://localhost,http://localhost:1420,http://127.0.0.1:1420"),
  REQUIRE_AGENT_CERTIFICATE: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
});

export type Config = z.infer<typeof environment>;

export function loadConfig(input = process.env): Config {
  return environment.parse(input);
}
