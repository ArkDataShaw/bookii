import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto";

function key() {
  const k = process.env.TOKEN_ENC_KEY;
  if (!k || k.length < 32) throw new Error("TOKEN_ENC_KEY missing or too short (need 32+ chars)");
  return Buffer.from(k.slice(0, 32), "utf8");
}

export function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `${iv.toString("hex")}.${c.getAuthTag().toString("hex")}.${enc.toString("hex")}`;
}

export function decrypt(blob) {
  const [iv, tag, data] = String(blob).split(".");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8");
}

// Signed OAuth state: userId.expiresMs.hmac
export function signState(userId, ttlMs = 600000) {
  const exp = Date.now() + ttlMs;
  const mac = createHmac("sha256", key()).update(`${userId}.${exp}`).digest("hex").slice(0, 32);
  return `${userId}.${exp}.${mac}`;
}

export function verifyState(state) {
  const [userId, exp, mac] = String(state || "").split(".");
  if (!userId || !exp || !mac || +exp < Date.now()) return null;
  const expect = createHmac("sha256", key()).update(`${userId}.${exp}`).digest("hex").slice(0, 32);
  const a = Buffer.from(mac), b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b) ? userId : null;
}
