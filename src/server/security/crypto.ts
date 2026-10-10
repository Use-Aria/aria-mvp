import "server-only";
/**
 * Crypto primitives for Aria V2 (spec §3.6, §4.10).
 *
 * - Random tokens (magic links, session ids) are base64url, and only their
 *   SHA-256 hash is ever stored.
 * - Secrets at rest (OAuth tokens, iCal URLs) use AES-256-GCM with a versioned
 *   prefix (`v1:`) so the key can be rotated without downtime.
 *
 * Pure module (only `node:crypto`), so it can be unit-tested with `node --test`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const KEY_VERSION = "v1";
const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16;

/** Random URL-safe token. 32 bytes = 256 bits by default. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Hex SHA-256 of a string (used to store tokens and session ids). */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time string comparison (false on length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Decode a base64 env key and check it is exactly 32 bytes (AES-256). */
export function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("Encryption key must be 32 bytes (base64-encoded)");
  }
  return key;
}

/**
 * Encrypt a secret with AES-256-GCM.
 * Output: `v1:<base64url(iv | ciphertext | tag)>`.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${KEY_VERSION}:${Buffer.concat([iv, ct, tag]).toString("base64url")}`;
}

/** Decrypt a value produced by `encryptSecret`. Throws if tampered. */
export function decryptSecret(encoded: string, key: Buffer): string {
  const sep = encoded.indexOf(":");
  const version = encoded.slice(0, sep);
  if (sep < 0 || version !== KEY_VERSION) {
    throw new Error(`Unsupported secret version: ${version || "(none)"}`);
  }
  const buf = Buffer.from(encoded.slice(sep + 1), "base64url");
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("Ciphertext too short");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
