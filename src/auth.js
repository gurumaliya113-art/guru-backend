// Minimal admin auth for the prototype.
// - Single admin credential from .env (ADMIN_EMAIL / ADMIN_PASSWORD)
// - On successful login we mint an opaque random token and keep it in memory.
// - Client sends it in `x-admin-token` header on every admin call.
//
// Swap this for Supabase Auth later — `requireAdmin` is the only contract
// that other code depends on.

import crypto from "crypto";

const TOKENS = new Set(); // active admin tokens
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12h

function mintToken() {
  const token = crypto.randomBytes(24).toString("hex");
  TOKENS.add(token);
  setTimeout(() => TOKENS.delete(token), TOKEN_TTL_MS).unref?.();
  return token;
}

export function adminLogin(email, password) {
  const expectedEmail = process.env.ADMIN_EMAIL || "admin@gurutron.local";
  const expectedPassword = process.env.ADMIN_PASSWORD || "changeme";
  if (!email || !password) return null;
  if (email.trim().toLowerCase() !== expectedEmail.toLowerCase()) return null;
  if (password !== expectedPassword) return null;
  return mintToken();
}

export function adminLogout(token) {
  if (token) TOKENS.delete(token);
}

export function isValidAdminToken(token) {
  return !!token && TOKENS.has(token);
}

export function requireAdmin(req, res, next) {
  // Accept token from header (default) OR query string (for iframes / <embed> / direct browser GETs)
  const token = req.header("x-admin-token") || req.query?.token;
  // Allow either a valid admin token OR a logged-in session user with role 'admin'
  const sessionIsAdmin = req.session?.user?.role === "admin";
  if (!isValidAdminToken(token) && !sessionIsAdmin) {
    return res.status(401).json({ error: "Admin authentication required" });
  }
  next();
}
