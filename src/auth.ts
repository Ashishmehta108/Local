import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Algorithm, hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

const scrypt = promisify(scryptCallback);

export function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

export async function hashSecret(secret: string): Promise<string> {
  return argon2Hash(secret, { algorithm: Algorithm.Argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32 });
}

export async function verifySecret(secret: string, encoded: string): Promise<boolean> {
  if (encoded.startsWith("$argon2id$")) return argon2Verify(encoded, secret).catch(() => false);
  const [algorithm, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = await scrypt(secret, salt, 64) as Buffer;
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
