import "dotenv/config";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createServer } from "./server.js";

const config = loadConfig();
const pool = createPool(config);
const app = createServer(config, pool);

async function start() {
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();

