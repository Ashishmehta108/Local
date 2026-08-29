import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import jwt from "@fastify/jwt";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import type { Pool, PoolClient } from "pg";
import type WebSocket from "ws";
import { z } from "zod";
import { hashSecret, normalizeEmail, normalizeSearch, opaqueToken, tokenHash, verifySecret } from "./auth.js";
import type { Config } from "./config.js";
import { commandSigner } from "./command-signing.js";
import { transaction } from "./db.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; organisationId: string; role: "ADMIN" | "MEMBER"; kind: "user" };
    user: { sub: string; organisationId: string; role: "ADMIN" | "MEMBER"; kind: "user" };
  }
}

const bootstrapSchema = z.object({ organisationName: z.string().min(2).max(120), email: z.string().email(), password: z.string().min(12), bootstrapToken: z.string().min(24) });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(32) });
const createUserSchema = z.object({ email: z.string().email(), password: z.string().min(12), role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER") });
const enrolmentSchema = z.object({ expiresInMinutes: z.number().int().min(5).max(1440).default(30) });
const deviceEnrolSchema = z.object({ code: z.string().min(16), name: z.string().min(1).max(120), os: z.string().min(1).max(120), publicKey: z.string().min(32).max(8192), certificateFingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() });
const rootSchema = z.object({ canonicalPath: z.string().min(3).max(32767) });
const eventSchema = z.object({
  eventId: z.string().uuid(), sequence: z.number().int().positive(), operation: z.enum(["UPSERT", "DELETE"]),
  rootId: z.string().uuid(), stableFileId: z.string().min(1).max(512),
  name: z.string().min(1).max(1024), relativePath: z.string().min(1).max(32767),
  extension: z.string().max(64).default(""), sizeBytes: z.number().int().nonnegative().default(0),
  modifiedAt: z.string().datetime()
});
const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(1000) });
const reconciliationEntrySchema = eventSchema.omit({ eventId: true, sequence: true, operation: true, rootId: true });
const reconciliationChunkSchema = z.object({ entries: z.array(reconciliationEntrySchema).min(1).max(1000) });
const searchSchema = z.object({ q: z.string().min(1).max(256), deviceId: z.string().uuid().optional(), extension: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const createCommandSchema = z.object({ fileId: z.string().uuid(), type: z.enum(["REVEAL_FILE", "OPEN_FILE"]) });
const commandAckSchema = z.object({
  outcome: z.enum(["SUCCEEDED", "FAILED"]),
  code: z.enum(["OK", "FILE_NOT_FOUND", "ROOT_DISABLED", "PATH_OUTSIDE_ROOT", "EXPIRED", "OS_ERROR"]),
  message: z.string().max(500).optional()
});

type UserClaims = { sub: string; organisationId: string; role: "ADMIN" | "MEMBER"; kind: "user" };
type Agent = { deviceId: string; organisationId: string; state: "ACTIVE" | "PAUSED" | "REVOKED"; certificateFingerprint: string | null };

function apiError(reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ error: { code, message } });
}

async function requireUser(request: FastifyRequest): Promise<UserClaims> {
  await request.jwtVerify();
  return request.user;
}

async function requireAdmin(request: FastifyRequest, reply: Parameters<typeof apiError>[0]): Promise<UserClaims | null> {
  const user = await requireUser(request);
  if (user.role !== "ADMIN") {
    apiError(reply, 403, "ADMIN_REQUIRED", "Administrator access is required.");
    return null;
  }
  return user;
}

async function requireAgent(request: FastifyRequest, pool: Pool, requireCertificate: boolean): Promise<Agent | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  const result = await pool.query<Agent>(
    `SELECT d.id AS "deviceId", d.organisation_id AS "organisationId", d.state, d.certificate_fingerprint AS "certificateFingerprint"
       FROM device_tokens dt JOIN devices d ON d.id = dt.device_id
      WHERE dt.token_hash = $1 AND dt.revoked_at IS NULL`,
    [tokenHash(token)]
  );
  const agent = result.rows[0] ?? null;
  if (!agent) return null;
  if (requireCertificate) {
    const presented = request.headers["x-filefinder-client-fingerprint"];
    if (typeof presented !== "string" || !agent.certificateFingerprint || presented.toLowerCase() !== agent.certificateFingerprint.toLowerCase()) return null;
  }
  return agent;
}

export function createServer(config: Config, pool: Pool): FastifyInstance {
  const app = Fastify({ logger: config.NODE_ENV !== "test", bodyLimit: 4 * 1024 * 1024 });
  app.register(jwt, { secret: config.JWT_SECRET });
  const allowedOrigins = new Set(config.UI_ORIGINS.split(",").map((origin) => origin.trim()));
  app.register(cors, {
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error("Origin is not allowed"), false);
    }
  });
  app.register(websocket);
  const signer = commandSigner(config.COMMAND_SIGNING_PRIVATE_KEY);
  const agentSockets = new Map<string, Set<WebSocket>>();

  function notifyAgent(deviceId: string, message: Record<string, unknown>) {
    const payload = JSON.stringify(message);
    for (const socket of agentSockets.get(deviceId) ?? []) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return apiError(reply, 400, "INVALID_REQUEST", error.issues.map((issue) => issue.message).join("; "));
    if ((error as { code?: string }).code === "23505") return apiError(reply, 409, "CONFLICT", "A record with those details already exists.");
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : "The request was rejected.";
      return apiError(reply, statusCode, "REQUEST_REJECTED", message);
    }
    app.log.error(error);
    return apiError(reply, 500, "INTERNAL_ERROR", "The coordinator could not complete the request.");
  });

  async function issueSession(client: Pool | PoolClient, user: { id: string; organisation_id: string; role: "ADMIN" | "MEMBER" }) {
    const refreshToken = opaqueToken(48);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    const session = await client.query<{ id: string }>(
      "INSERT INTO refresh_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id",
      [user.id, tokenHash(refreshToken), expiresAt]
    );
    const accessToken = app.jwt.sign({ sub: user.id, organisationId: user.organisation_id, role: user.role, kind: "user" }, { expiresIn: "15m" });
    return { accessToken, refreshToken, refreshExpiresAt: expiresAt.toISOString(), sessionId: session.rows[0].id };
  }

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/api/v1/coordinator/identity", async () => ({ commandSigningPublicKey: signer.publicKeyDerBase64, algorithm: "Ed25519" }));
  app.get("/api/v1/agent/live", { websocket: true }, async (socket, request) => {
    const agent = await requireAgent(request, pool, config.REQUIRE_AGENT_CERTIFICATE);
    if (!agent || agent.state !== "ACTIVE") {
      socket.close(1008, "Device authentication failed");
      return;
    }
    const sockets = agentSockets.get(agent.deviceId) ?? new Set<WebSocket>();
    sockets.add(socket);
    agentSockets.set(agent.deviceId, sockets);
    await pool.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [agent.deviceId]);
    socket.send(JSON.stringify({ type: "CONNECTED", heartbeatSeconds: 30, serverTime: new Date().toISOString() }));
    socket.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "HEARTBEAT") {
          await pool.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [agent.deviceId]);
          socket.send(JSON.stringify({ type: "HEARTBEAT_ACK", serverTime: new Date().toISOString() }));
        }
      } catch (error) {
        app.log.warn({ error, deviceId: agent.deviceId }, "invalid agent socket message");
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      if (sockets.size === 0) agentSockets.delete(agent.deviceId);
    });
  });
  app.get("/readyz", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.post("/api/v1/auth/bootstrap", async (request, reply) => {
    const input = bootstrapSchema.parse(request.body);
    if (input.bootstrapToken !== config.BOOTSTRAP_TOKEN) return apiError(reply, 401, "INVALID_BOOTSTRAP_TOKEN", "Bootstrap token is invalid.");
    const result = await transaction(pool, async (client) => {
      const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM users");
      if (Number(count.rows[0].count) > 0) return null;
      const organisation = await client.query<{ id: string }>("INSERT INTO organisations (name) VALUES ($1) RETURNING id", [input.organisationName]);
      const passwordHash = await hashSecret(input.password);
      const user = await client.query<{ id: string; organisation_id: string; role: "ADMIN" }>(
        "INSERT INTO users (organisation_id, email, password_hash, role) VALUES ($1, $2, $3, 'ADMIN') RETURNING id, organisation_id, role",
        [organisation.rows[0].id, normalizeEmail(input.email), passwordHash]
      );
      await audit(client, user.rows[0].organisation_id, "user", user.rows[0].id, "ORGANISATION_BOOTSTRAPPED", "organisation", organisation.rows[0].id, "SUCCESS");
      return user.rows[0];
    });
    if (!result) return apiError(reply, 409, "ALREADY_BOOTSTRAPPED", "The coordinator already has users.");
    const session = await issueSession(pool, result);
    return reply.code(201).send({ ...session, user: { id: result.id, role: result.role } });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await pool.query<{ id: string; organisation_id: string; role: "ADMIN" | "MEMBER"; password_hash: string }>(
      "SELECT id, organisation_id, role, password_hash FROM users WHERE email = $1 LIMIT 1",
      [normalizeEmail(input.email)]
    );
    const found = user.rows[0];
    if (!found || !(await verifySecret(input.password, found.password_hash))) return apiError(reply, 401, "INVALID_CREDENTIALS", "Email or password is invalid.");
    const session = await issueSession(pool, found);
    return { ...session, user: { id: found.id, role: found.role } };
  });

  app.post("/api/v1/auth/refresh", async (request, reply) => {
    const input = refreshSchema.parse(request.body);
    const result = await transaction(pool, async (client) => {
      const current = await client.query<{ id: string; user_id: string; organisation_id: string; role: "ADMIN" | "MEMBER" }>(
        `SELECT rs.id, u.id AS user_id, u.organisation_id, u.role
           FROM refresh_sessions rs JOIN users u ON u.id = rs.user_id
          WHERE rs.token_hash = $1 AND rs.revoked_at IS NULL AND rs.expires_at > now()
          FOR UPDATE`,
        [tokenHash(input.refreshToken)]
      );
      const row = current.rows[0];
      if (!row) return null;
      const replacement = await issueSession(client, { id: row.user_id, organisation_id: row.organisation_id, role: row.role });
      await client.query("UPDATE refresh_sessions SET revoked_at = now(), last_used_at = now(), replaced_by_id = $2 WHERE id = $1", [row.id, replacement.sessionId]);
      return { ...replacement, user: { id: row.user_id, role: row.role } };
    });
    if (!result) return apiError(reply, 401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid, expired or already used.");
    return result;
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const input = refreshSchema.parse(request.body);
    await pool.query("UPDATE refresh_sessions SET revoked_at = now(), last_used_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash(input.refreshToken)]);
    return reply.code(204).send();
  });

  app.get("/api/v1/users", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return;
    const result = await pool.query(
      `SELECT id, email, role, created_at AS "createdAt" FROM users
        WHERE organisation_id = $1 ORDER BY email`,
      [user.organisationId]
    );
    return { items: result.rows };
  });

  app.post("/api/v1/users", async (request, reply) => {
    const actor = await requireAdmin(request, reply);
    if (!actor) return;
    const input = createUserSchema.parse(request.body);
    const passwordHash = await hashSecret(input.password);
    const result = await pool.query<{ id: string; email: string; role: "ADMIN" | "MEMBER"; createdAt: string }>(
      `INSERT INTO users (organisation_id, email, password_hash, role) VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, created_at AS "createdAt"`,
      [actor.organisationId, normalizeEmail(input.email), passwordHash, input.role]
    );
    await audit(pool, actor.organisationId, "user", actor.sub, "USER_CREATED", "user", result.rows[0].id, "SUCCESS", { role: input.role });
    return reply.code(201).send(result.rows[0]);
  });

  app.post("/api/v1/enrolments", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return;
    const input = enrolmentSchema.parse(request.body);
    const code = opaqueToken(24);
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);
    const row = await pool.query<{ id: string }>(
      "INSERT INTO enrolments (organisation_id, code_hash, expires_at, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
      [user.organisationId, tokenHash(code), expiresAt, user.sub]
    );
    await audit(pool, user.organisationId, "user", user.sub, "ENROLMENT_CREATED", "enrolment", row.rows[0].id, "SUCCESS");
    return reply.code(201).send({ id: row.rows[0].id, code, expiresAt: expiresAt.toISOString() });
  });

  app.post("/api/v1/devices/enrol", async (request, reply) => {
    const input = deviceEnrolSchema.parse(request.body);
    const outcome = await transaction(pool, async (client) => {
      const enrolment = await client.query<{ id: string; organisation_id: string }>(
        `SELECT id, organisation_id FROM enrolments
          WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
          FOR UPDATE`, [tokenHash(input.code)]
      );
      if (!enrolment.rows[0]) return null;
      await client.query("UPDATE enrolments SET consumed_at = now() WHERE id = $1", [enrolment.rows[0].id]);
      const device = await client.query<{ id: string }>(
        "INSERT INTO devices (organisation_id, name, os, public_key, certificate_fingerprint) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [enrolment.rows[0].organisation_id, input.name, input.os, input.publicKey, input.certificateFingerprint?.toLowerCase() ?? null]
      );
      const agentToken = opaqueToken();
      await client.query("INSERT INTO device_tokens (device_id, token_hash) VALUES ($1, $2)", [device.rows[0].id, tokenHash(agentToken)]);
      await audit(client, enrolment.rows[0].organisation_id, "device", device.rows[0].id, "DEVICE_ENROLLED", "device", device.rows[0].id, "SUCCESS");
      return { deviceId: device.rows[0].id, agentToken };
    });
    if (!outcome) return apiError(reply, 401, "INVALID_ENROLMENT", "Enrolment code is invalid, expired or already used.");
    return reply.code(201).send({ ...outcome, commandSigningPublicKey: signer.publicKeyDerBase64 });
  });

  app.post("/api/v1/devices/:deviceId/roots", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return;
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const input = rootSchema.parse(request.body);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO indexed_roots (organisation_id, device_id, canonical_path)
       SELECT $1, id, $3 FROM devices WHERE id = $2 AND organisation_id = $1 AND state = 'ACTIVE'
       RETURNING id`,
      [user.organisationId, deviceId, input.canonicalPath]
    );
    if (!result.rows[0]) return apiError(reply, 404, "DEVICE_NOT_FOUND", "Active device was not found.");
    await audit(pool, user.organisationId, "user", user.sub, "ROOT_ADDED", "indexed_root", result.rows[0].id, "SUCCESS", { deviceId });
    return reply.code(201).send({ id: result.rows[0].id });
  });

  app.post("/api/v1/agent/events/batch", async (request, reply) => {
    const agent = await requireAgent(request, pool, config.REQUIRE_AGENT_CERTIFICATE);
    if (!agent) return apiError(reply, 401, "INVALID_DEVICE_TOKEN", "Device authentication failed.");
    if (agent.state !== "ACTIVE") return apiError(reply, 403, "DEVICE_NOT_ACTIVE", "The device is not active.");
    const input = batchSchema.parse(request.body);
    const events = [...input.events].sort((a, b) => a.sequence - b.sequence);
    for (let index = 1; index < events.length; index++) {
      if (events[index].sequence !== events[index - 1].sequence + 1) return apiError(reply, 409, "INVALID_SEQUENCE", "Batch sequences must be contiguous.");
    }
    const response = await transaction(pool, async (client) => ingestBatch(client, agent, events));
    if (response.kind === "gap") return apiError(reply, 409, "SEQUENCE_GAP", `Expected sequence ${response.expectedSequence}.`);
    if (response.kind === "conflict") return apiError(reply, 409, "EVENT_REPLAY_CONFLICT", "A replayed sequence does not match its original event ID.");
    return { acknowledgedSequence: response.acknowledgedSequence };
  });

  app.post("/api/v1/agent/heartbeat", async (request, reply) => {
    const agent = await requireAgent(request, pool, config.REQUIRE_AGENT_CERTIFICATE);
    if (!agent) return apiError(reply, 401, "INVALID_DEVICE_TOKEN", "Device authentication failed.");
    if (agent.state !== "ACTIVE") return apiError(reply, 403, "DEVICE_NOT_ACTIVE", "The device is not active.");
    await pool.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [agent.deviceId]);
    return { serverTime: new Date().toISOString(), nextHeartbeatSeconds: 30 };
  });

  app.post("/api/v1/agent/reconciliations", async (request, reply) => {
    const agent = await requireAgent(request, pool, config.REQUIRE_AGENT_CERTIFICATE);
    if (!agent) return apiError(reply, 401, "INVALID_DEVICE_TOKEN", "Device authentication failed.");
    if (agent.state !== "ACTIVE") return apiError(reply, 403, "DEVICE_NOT_ACTIVE", "The device is not active.");
    const { rootId } = z.object({ rootId: z.string().uuid() }).parse(request.body);
    const result = await pool.query<{ id: string }>(
      `INSERT INTO reconciliation_sessions (organisation_id, device_id, root_id)
       SELECT $1, $2, id FROM indexed_roots WHERE id = $3 AND device_id = $2 AND enabled = true
       RETURNING id`,
      [agent.organisationId, agent.deviceId, rootId]
    );
    if (!result.rows[0]) return apiError(reply, 404, "ROOT_NOT_FOUND", "Enabled indexed root was not found.");
    return reply.code(201).send({ id: result.rows[0].id });
  });

  app.post("/api/v1/agent/reconciliations/:sessionId/chunks", async (request, reply) => {
    const agent = await requireAgent(request, pool, config.REQUIRE_AGENT_CERTIFICATE);
    if (!agent) return apiError(reply, 401, "INVALID_DEVICE_TOKEN", "Device authentication failed.");
    if (agent.state !== "ACTIVE") return apiError(reply, 403, "DEVICE_NOT_ACTIVE", "The device is not active.");
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const input = reconciliationChunkSchema.parse(request.body);
    const accepted = await transaction(pool, async (client) => stageReconciliationChunk(client, agent, sessionId, input.entries));
    if (accepted === null) return apiError(reply, 404, "RECONCILIATION_NOT_FOUND", "Uploading reconciliation session was not found.");
    return { acceptedEntries: accepted };
  });

  app.post("/api/v1/agent/reconciliations/:sessionId/complete", async (request, reply) => {
    const agent = await requireAgent(request, pool, config.REQUIRE_AGENT_CERTIFICATE);
    if (!agent) return apiError(reply, 401, "INVALID_DEVICE_TOKEN", "Device authentication failed.");
    if (agent.state !== "ACTIVE") return apiError(reply, 403, "DEVICE_NOT_ACTIVE", "The device is not active.");
    const { sessionId } = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const result = await transaction(pool, async (client) => completeReconciliation(client, agent, sessionId));
    if (!result) return apiError(reply, 404, "RECONCILIATION_NOT_FOUND", "Uploading reconciliation session was not found.");
    return result;
  });

  app.get("/api/v1/agent/commands", async (request, reply) => {
    const agent = await requireAgent(request, pool, config.REQUIRE_AGENT_CERTIFICATE);
    if (!agent) return apiError(reply, 401, "INVALID_DEVICE_TOKEN", "Device authentication failed.");
    if (agent.state !== "ACTIVE") return apiError(reply, 403, "DEVICE_NOT_ACTIVE", "The device is not active.");
    const commands = await transaction(pool, async (client) => {
      await client.query(
        `UPDATE device_commands SET status = 'EXPIRED', completed_at = now(), outcome_code = 'EXPIRED'
          WHERE device_id = $1 AND status IN ('PENDING', 'DELIVERED') AND expires_at <= now()`,
        [agent.deviceId]
      );
      const result = await client.query<{
        id: string; type: "REVEAL_FILE" | "OPEN_FILE"; expiresAt: string | Date;
        fileId: string; rootId: string; stableFileId: string;
      }>(
        `WITH selected AS (
           SELECT id FROM device_commands
            WHERE device_id = $1 AND expires_at > now() AND attempts < 5
              AND (status = 'PENDING' OR (status = 'DELIVERED' AND delivered_at < now() - interval '10 seconds'))
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10
         )
         UPDATE device_commands dc
            SET status = 'DELIVERED', delivered_at = now(), attempts = attempts + 1
           FROM selected, files f
          WHERE dc.id = selected.id AND f.id = dc.file_id
         RETURNING dc.id, dc.type, dc.expires_at AS "expiresAt", f.id AS "fileId",
                   f.root_id AS "rootId", f.stable_file_id AS "stableFileId"`
        , [agent.deviceId]
      );
      await client.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [agent.deviceId]);
      return result.rows.map((command) => {
        const expiresAt = command.expiresAt instanceof Date ? command.expiresAt.toISOString() : new Date(command.expiresAt).toISOString();
        return signer.sign({ ...command, expiresAt });
      });
    });
    return { items: commands };
  });

  app.post("/api/v1/agent/commands/:commandId/ack", async (request, reply) => {
    const agent = await requireAgent(request, pool, config.REQUIRE_AGENT_CERTIFICATE);
    if (!agent) return apiError(reply, 401, "INVALID_DEVICE_TOKEN", "Device authentication failed.");
    const { commandId } = z.object({ commandId: z.string().uuid() }).parse(request.params);
    const input = commandAckSchema.parse(request.body);
    const result = await transaction(pool, async (client) => {
      const updated = await client.query<{ organisation_id: string }>(
        `UPDATE device_commands
            SET status = $3::device_command_status, completed_at = now(), outcome_code = $4, outcome_message = $5
          WHERE id = $1 AND device_id = $2 AND status = 'DELIVERED' AND expires_at > now()
          RETURNING organisation_id`,
        [commandId, agent.deviceId, input.outcome, input.code, input.message ?? null]
      );
      if (!updated.rows[0]) return null;
      await audit(client, updated.rows[0].organisation_id, "device", agent.deviceId, "COMMAND_COMPLETED", "device_command", commandId, input.outcome, { code: input.code });
      return updated.rows[0];
    });
    if (!result) return apiError(reply, 409, "COMMAND_NOT_ACKNOWLEDGEABLE", "Command is expired, completed or does not belong to this device.");
    return reply.code(204).send();
  });

  app.get("/api/v1/files/search", async (request, reply) => {
    const user = await requireUser(request);
    const input = searchSchema.parse(request.query);
    const term = normalizeSearch(input.q);
    const result = await pool.query(
      `SELECT f.id, f.name, f.relative_path AS "relativePath", f.extension, f.size_bytes AS "sizeBytes", f.modified_at AS "modifiedAt",
              d.id AS "deviceId", d.name AS "deviceName", d.state, d.last_seen_at AS "lastSeenAt",
              CASE WHEN d.last_seen_at >= now() - interval '60 seconds' THEN 'ONLINE'
                   WHEN d.last_seen_at >= now() - interval '5 minutes' THEN 'STALE'
                   ELSE 'OFFLINE' END AS presence,
              r.canonical_path AS "rootPath",
              GREATEST(similarity(f.normalized_name, $2), similarity(f.normalized_relative_path, $2)) AS score
         FROM files f
         JOIN devices d ON d.id = f.device_id
         JOIN indexed_roots r ON r.id = f.root_id
        WHERE f.organisation_id = $1 AND f.deleted_at IS NULL AND d.state = 'ACTIVE' AND r.enabled = true
          AND ($3::uuid IS NULL OR d.id = $3)
          AND ($4::text IS NULL OR f.extension = $4)
          AND (f.normalized_name % $2 OR f.normalized_relative_path % $2 OR f.normalized_name LIKE $2 || '%')
        ORDER BY CASE WHEN f.normalized_name = $2 THEN 0 WHEN f.normalized_name LIKE $2 || '%' THEN 1 ELSE 2 END,
                 score DESC, f.normalized_name ASC
        LIMIT $5`,
      [user.organisationId, term, input.deviceId ?? null, input.extension?.toLowerCase() ?? null, input.limit]
    );
    return { items: result.rows };
  });

  app.get("/api/v1/devices", async (request, reply) => {
    const user = await requireUser(request);
    const result = await pool.query(
      `SELECT id, name, os, state, last_seen_at AS "lastSeenAt", last_sequence AS "lastSequence", created_at AS "createdAt",
              CASE WHEN state <> 'ACTIVE' THEN state::text
                   WHEN last_seen_at >= now() - interval '60 seconds' THEN 'ONLINE'
                   WHEN last_seen_at >= now() - interval '5 minutes' THEN 'STALE'
                   ELSE 'OFFLINE' END AS presence
         FROM devices WHERE organisation_id = $1 ORDER BY name`, [user.organisationId]
    );
    return { items: result.rows };
  });

  app.get("/api/v1/indexed-roots", async (request) => {
    const user = await requireUser(request);
    const result = await pool.query(
      `SELECT id, device_id AS "deviceId", canonical_path AS "canonicalPath", enabled,
              last_scan_at AS "lastScanAt", created_at AS "createdAt"
         FROM indexed_roots WHERE organisation_id = $1 ORDER BY canonical_path`,
      [user.organisationId]
    );
    return { items: result.rows };
  });

  app.patch("/api/v1/indexed-roots/:rootId", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return;
    const { rootId } = z.object({ rootId: z.string().uuid() }).parse(request.params);
    const input = z.object({ enabled: z.boolean() }).parse(request.body);
    const result = await pool.query<{ id: string; enabled: boolean }>(
      `UPDATE indexed_roots SET enabled = $3 WHERE id = $2 AND organisation_id = $1 RETURNING id, enabled`,
      [user.organisationId, rootId, input.enabled]
    );
    if (!result.rows[0]) return apiError(reply, 404, "ROOT_NOT_FOUND", "Indexed root was not found.");
    await audit(pool, user.organisationId, "user", user.sub, input.enabled ? "ROOT_ENABLED" : "ROOT_DISABLED", "indexed_root", rootId, "SUCCESS");
    return result.rows[0];
  });

  app.post("/api/v1/commands", async (request, reply) => {
    const user = await requireUser(request);
    const input = createCommandSchema.parse(request.body);
    const expiresAt = new Date(Date.now() + 60_000);
    const result = await transaction(pool, async (client) => {
      const file = await client.query<{ file_id: string; device_id: string }>(
        `SELECT f.id AS file_id, f.device_id
           FROM files f JOIN devices d ON d.id = f.device_id JOIN indexed_roots r ON r.id = f.root_id
          WHERE f.id = $1 AND f.organisation_id = $2 AND f.deleted_at IS NULL
            AND d.state = 'ACTIVE' AND d.last_seen_at >= now() - interval '60 seconds' AND r.enabled = true`,
        [input.fileId, user.organisationId]
      );
      if (!file.rows[0]) return null;
      const command = await client.query<{ id: string }>(
        `INSERT INTO device_commands (organisation_id, device_id, file_id, requested_by, type, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user.organisationId, file.rows[0].device_id, file.rows[0].file_id, user.sub, input.type, expiresAt]
      );
      await audit(client, user.organisationId, "user", user.sub, "COMMAND_CREATED", "device_command", command.rows[0].id, "SUCCESS", { type: input.type, fileId: input.fileId });
      return { id: command.rows[0].id, deviceId: file.rows[0].device_id, expiresAt: expiresAt.toISOString() };
    });
    if (!result) return apiError(reply, 409, "FILE_NOT_ACTIONABLE", "File is unavailable, outside an enabled root or its device is offline.");
    notifyAgent(result.deviceId, { type: "COMMAND_AVAILABLE", commandId: result.id });
    return reply.code(201).send({ id: result.id, expiresAt: result.expiresAt });
  });

  app.get("/api/v1/commands/:commandId", async (request, reply) => {
    const user = await requireUser(request);
    const { commandId } = z.object({ commandId: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `SELECT id, type, status, attempts, expires_at AS "expiresAt", outcome_code AS "outcomeCode",
              outcome_message AS "outcomeMessage", created_at AS "createdAt", completed_at AS "completedAt"
         FROM device_commands WHERE id = $1 AND organisation_id = $2`,
      [commandId, user.organisationId]
    );
    if (!result.rows[0]) return apiError(reply, 404, "COMMAND_NOT_FOUND", "Command was not found.");
    return result.rows[0];
  });

  app.get("/api/v1/audit", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return;
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    const result = await pool.query(
      `SELECT id, actor_type AS "actorType", actor_id AS "actorId", action, target_type AS "targetType",
              target_id AS "targetId", outcome, details, created_at AS "createdAt"
         FROM audit_log WHERE organisation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [user.organisationId, query.limit]
    );
    return { items: result.rows };
  });

  app.patch("/api/v1/devices/:deviceId", async (request, reply) => {
    const user = await requireAdmin(request, reply);
    if (!user) return;
    const { deviceId } = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const input = z.object({ name: z.string().min(1).max(120).optional(), state: z.enum(["ACTIVE", "PAUSED", "REVOKED"]).optional() }).refine((value) => value.name || value.state).parse(request.body);
    const result = await transaction(pool, async (client) => {
      const updated = await client.query<{ id: string; state: string }>(
        `UPDATE devices SET name = COALESCE($3, name), state = COALESCE($4::device_state, state)
          WHERE id = $2 AND organisation_id = $1 RETURNING id, state`,
        [user.organisationId, deviceId, input.name ?? null, input.state ?? null]
      );
      if (updated.rows[0]?.state === "REVOKED") await client.query("UPDATE device_tokens SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL", [deviceId]);
      return updated.rows[0] ?? null;
    });
    if (!result) return apiError(reply, 404, "DEVICE_NOT_FOUND", "Device was not found.");
    await audit(pool, user.organisationId, "user", user.sub, "DEVICE_UPDATED", "device", deviceId, "SUCCESS", input);
    return result;
  });

  return app;
}

async function stageReconciliationChunk(client: PoolClient, agent: Agent, sessionId: string, entries: z.infer<typeof reconciliationEntrySchema>[]) {
  const session = await client.query<{ id: string }>(
    "SELECT id FROM reconciliation_sessions WHERE id = $1 AND device_id = $2 AND state = 'UPLOADING' FOR UPDATE",
    [sessionId, agent.deviceId]
  );
  if (!session.rows[0]) return null;
  for (const entry of entries) {
    await client.query(
      `INSERT INTO reconciliation_entries
         (session_id, stable_file_id, name, normalized_name, relative_path, normalized_relative_path, extension, size_bytes, modified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (session_id, stable_file_id) DO UPDATE SET
         name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name,
         relative_path = EXCLUDED.relative_path, normalized_relative_path = EXCLUDED.normalized_relative_path,
         extension = EXCLUDED.extension, size_bytes = EXCLUDED.size_bytes, modified_at = EXCLUDED.modified_at`,
      [sessionId, entry.stableFileId, entry.name, normalizeSearch(entry.name), entry.relativePath, normalizeSearch(entry.relativePath), entry.extension.toLowerCase(), entry.sizeBytes, entry.modifiedAt]
    );
  }
  const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM reconciliation_entries WHERE session_id = $1", [sessionId]);
  await client.query("UPDATE reconciliation_sessions SET entry_count = $2 WHERE id = $1", [sessionId, count.rows[0].count]);
  return entries.length;
}

async function completeReconciliation(client: PoolClient, agent: Agent, sessionId: string) {
  const session = await client.query<{ root_id: string; entry_count: string }>(
    "SELECT root_id, entry_count FROM reconciliation_sessions WHERE id = $1 AND device_id = $2 AND state = 'UPLOADING' FOR UPDATE",
    [sessionId, agent.deviceId]
  );
  const row = session.rows[0];
  if (!row) return null;
  await client.query(
    `INSERT INTO files
       (organisation_id, device_id, root_id, stable_file_id, name, normalized_name, relative_path, normalized_relative_path, extension, size_bytes, modified_at, deleted_at)
     SELECT $1, $2, $3, stable_file_id, name, normalized_name, relative_path, normalized_relative_path, extension, size_bytes, modified_at, NULL
       FROM reconciliation_entries WHERE session_id = $4
     ON CONFLICT (device_id, root_id, stable_file_id) DO UPDATE SET
       name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name,
       relative_path = EXCLUDED.relative_path, normalized_relative_path = EXCLUDED.normalized_relative_path,
       extension = EXCLUDED.extension, size_bytes = EXCLUDED.size_bytes,
       modified_at = EXCLUDED.modified_at, deleted_at = NULL, updated_at = now()`,
    [agent.organisationId, agent.deviceId, row.root_id, sessionId]
  );
  const removed = await client.query(
    `UPDATE files f SET deleted_at = now(), updated_at = now()
      WHERE f.device_id = $1 AND f.root_id = $2 AND f.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM reconciliation_entries re WHERE re.session_id = $3 AND re.stable_file_id = f.stable_file_id)`,
    [agent.deviceId, row.root_id, sessionId]
  );
  await client.query("UPDATE indexed_roots SET last_scan_at = now() WHERE id = $1", [row.root_id]);
  await client.query("UPDATE reconciliation_sessions SET state = 'COMPLETED', completed_at = now() WHERE id = $1", [sessionId]);
  await client.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [agent.deviceId]);
  return { indexedEntries: Number(row.entry_count), tombstonedEntries: removed.rowCount ?? 0 };
}

async function ingestBatch(client: PoolClient, agent: Agent, events: z.infer<typeof eventSchema>[]) {
  const device = await client.query<{ last_sequence: string }>("SELECT last_sequence FROM devices WHERE id = $1 FOR UPDATE", [agent.deviceId]);
  const lastSequence = Number(device.rows[0].last_sequence);
  const replayed = events.filter((event) => event.sequence <= lastSequence);
  if (replayed.length > 0) {
    const existing = await client.query<{ sequence: string; event_id: string }>(
      "SELECT sequence, event_id FROM agent_events WHERE device_id = $1 AND sequence = ANY($2::bigint[])",
      [agent.deviceId, replayed.map((event) => event.sequence)]
    );
    const eventIdBySequence = new Map(existing.rows.map((row) => [Number(row.sequence), row.event_id]));
    if (replayed.some((event) => eventIdBySequence.get(event.sequence) !== event.eventId)) {
      return { kind: "conflict" as const, acknowledgedSequence: lastSequence };
    }
  }
  const pending = events.filter((event) => event.sequence > lastSequence);
  if (pending.length === 0) return { kind: "ack" as const, acknowledgedSequence: lastSequence };
  if (pending[0].sequence !== lastSequence + 1) return { kind: "gap" as const, expectedSequence: lastSequence + 1 };
  for (const event of pending) {
    const root = await client.query<{ id: string }>("SELECT id FROM indexed_roots WHERE id = $1 AND device_id = $2 AND enabled = true", [event.rootId, agent.deviceId]);
    if (!root.rows[0]) throw new Error("Event referenced an unauthorised indexed root.");
    await client.query("INSERT INTO agent_events (device_id, sequence, event_id, operation) VALUES ($1, $2, $3, $4)", [agent.deviceId, event.sequence, event.eventId, event.operation]);
    if (event.operation === "DELETE") {
      await client.query("UPDATE files SET deleted_at = now(), updated_at = now() WHERE device_id = $1 AND root_id = $2 AND stable_file_id = $3", [agent.deviceId, event.rootId, event.stableFileId]);
    } else {
      await client.query(
        `INSERT INTO files (organisation_id, device_id, root_id, stable_file_id, name, normalized_name, relative_path, normalized_relative_path, extension, size_bytes, modified_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL)
         ON CONFLICT (device_id, root_id, stable_file_id) DO UPDATE SET
           name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name, relative_path = EXCLUDED.relative_path,
           normalized_relative_path = EXCLUDED.normalized_relative_path, extension = EXCLUDED.extension,
           size_bytes = EXCLUDED.size_bytes, modified_at = EXCLUDED.modified_at, deleted_at = NULL, updated_at = now()`,
        [agent.organisationId, agent.deviceId, event.rootId, event.stableFileId, event.name, normalizeSearch(event.name), event.relativePath, normalizeSearch(event.relativePath), event.extension.toLowerCase(), event.sizeBytes, event.modifiedAt]
      );
    }
  }
  const acknowledgedSequence = pending.at(-1)!.sequence;
  await client.query("UPDATE devices SET last_sequence = $2, last_seen_at = now() WHERE id = $1", [agent.deviceId, acknowledgedSequence]);
  return { kind: "ack" as const, acknowledgedSequence };
}

async function audit(client: Pool | PoolClient, organisationId: string, actorType: string, actorId: string | null, action: string, targetType: string, targetId: string | null, outcome: string, details: Record<string, unknown> = {}) {
  await client.query(
    `INSERT INTO audit_log (organisation_id, actor_type, actor_id, action, target_type, target_id, outcome, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [organisationId, actorType, actorId, action, targetType, targetId, outcome, details]
  );
}
