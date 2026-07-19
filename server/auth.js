import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { q } from "./db.js";

const scryptAsync = promisify(scrypt);

export async function hashPassword(pw) {
  const salt = randomBytes(16).toString("hex");
  const buf = await scryptAsync(pw, salt, 64);
  return `${salt}:${buf.toString("hex")}`;
}

export async function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const buf = await scryptAsync(pw, salt, 64);
  const target = Buffer.from(hash, "hex");
  return buf.length === target.length && timingSafeEqual(buf, target);
}

export async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  await q(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2, now() + interval '30 days')`, [token, userId]);
  return token;
}

export async function requireUser(c) {
  const auth = c.req.header("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const r = await q(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token=$1 AND s.expires_at > now()`,
    [token]
  );
  return r.rows[0] || null;
}

export const RESERVED_USERNAMES = new Set([
  "api", "app", "www", "admin", "auth", "login", "signup", "settings", "book", "u",
  "host", "agent", "proposal", "help", "docs", "blog", "about", "pricing", "team",
  "teams", "billing", "static", "assets", "bookii", "support", "status", "legal",
]);

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
