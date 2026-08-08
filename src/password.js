// Lightweight password hashing using Node's built-in crypto.scrypt.
// Format stored in DB: "scrypt$<saltHex>$<hashHex>"
// No external dependency. Safe for our prototype scale.

import crypto from "crypto";

const KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(plain, stored) {
  if (!plain || !stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  try {
    const derived = crypto.scryptSync(plain, salt, expected.length, SCRYPT_PARAMS);
    // timingSafeEqual throws if lengths differ.
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
