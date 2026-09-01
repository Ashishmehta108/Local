import { z } from "zod";

const environment = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(7443),
  TRUST_PROXY: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  JWT_SECRET: z.string().min(32),
  BOOTSTRAP_TOKEN: z.string().min(24),
  COMMAND_SIGNING_PRIVATE_KEY: z.string().min(64),
  UI_ORIGINS: z.string().default("https://tauri.localhost,tauri://localhost,http://localhost:1420,http://127.0.0.1:1420"),
  REQUIRE_AGENT_SIGNATURES: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  REQUIRE_AGENT_CERTIFICATE: z.enum(["true", "false"]).default("false").transform((value) => value === "true")
}).superRefine((value, context) => {
  if (value.NODE_ENV !== "production") return;
  const placeholder = /replace[-_ ]?this|change[-_ ]?me|example/i;
  if (placeholder.test(value.JWT_SECRET)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["JWT_SECRET"], message: "Production JWT secret is a placeholder" });
  }
  if (placeholder.test(value.BOOTSTRAP_TOKEN)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["BOOTSTRAP_TOKEN"], message: "Production bootstrap token is a placeholder" });
  }
  for (const origin of value.UI_ORIGINS.split(",").map((item) => item.trim())) {
    if (!origin.startsWith("https://") && !origin.startsWith("tauri://")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["UI_ORIGINS"], message: `Production UI origin must be HTTPS or Tauri: ${origin}` });
    }
  }
});

export type Config = z.infer<typeof environment>;

export function loadConfig(input = process.env): Config {
  return environment.parse(input);
}
