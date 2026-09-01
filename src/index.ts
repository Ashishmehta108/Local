import "dotenv/config";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createServer } from "./server.js";

const config = loadConfig();
const pool = createPool(config);
const app = createServer(config, pool);
let stopping = false;

async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "shutting down");
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (error) {
    app.log.error(error, "graceful shutdown failed");
    process.exit(1);
  }
}

async function start() {
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

