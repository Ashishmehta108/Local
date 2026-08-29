import { Pool, type PoolClient } from "pg";
import type { Config } from "./config.js";

export function createPool(config: Config): Pool {
  return new Pool({ connectionString: config.DATABASE_URL, max: 10 });
}

export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

