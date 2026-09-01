import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrations.js";

const config = loadConfig({
  ...process.env,
  DATABASE_URL: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
});
const pool = createPool(config);

try {
  await migrate(pool);
  console.log("Database migrations are current.");
} finally {
  await pool.end();
}
