import { readdir, readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { transaction } from "./db.js";

export async function migrate(pool: Pool, directory = new URL("../db/migrations/", import.meta.url)) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    await transaction(pool, async (client) => {
      await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const alreadyApplied = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (alreadyApplied.rowCount) return;
      await client.query(await readFile(new URL(name, directory), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
  }
}

