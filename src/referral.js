// =============================================================
//  Referral & Commission business logic (storage-agnostic).
//  Works on top of the storage primitives in storage/{supabase,json}.js.
// =============================================================
import crypto from "crypto";

// Commission rates / reward tiers (single source of truth).
export const COMMISSION_PERCENT = 10;          // teacher referrers earn 10%
export const COINS_PER_REFERRAL = 100;         // student->student reward
export const REFERRALS_PER_PREMIUM_MONTH = 10; // every 10 referrals
export const PREMIUM_DAYS_PER_MONTH = 30;

const CODE_PREFIX = "GURU";

function sanitizeNamePart(name) {
  const cleaned = String(name || "")
    .trim()
    .split(/\s+/)[0] // first word only
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 12);
}

/**
 * Generate a unique referral code like "GURU-MUKUL". Falls back to a random
 * suffix when the name is empty or the base code is already taken.
 */
export async function generateReferralCode(storage, name) {
  const base = sanitizeNamePart(name);
  const candidates = [];
  if (base) {
    candidates.push(`${CODE_PREFIX}-${base}`);
    for (let i = 2; i <= 9; i++) candidates.push(`${CODE_PREFIX}-${base}${i}`);
  }
  for (const code of candidates) {
    const existing = await storage.getProfileByReferralCode?.(code);
    if (!existing) return code;
  }
  // Fully random fallback (collision-resistant).
  for (let i = 0; i < 20; i++) {
    const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
    const code = `${CODE_PREFIX}-${rand}`;
    const existing = await storage.getProfileByReferralCode?.(code);
    if (!existing) return code;
  }
  return `${CODE_PREFIX}-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Ensure a profile has a referral_code, generating + persisting one if missing.
 * Returns the (possibly updated) profile.
 */
export async function ensureReferralCode(storage, userId, profile) {
  if (!profile) return profile;
  if (profile.referralCode) return profile;
  const code = await generateReferralCode(storage, profile.name || "");
  const updated = { ...profile, referralCode: code };
  try {
    await storage.saveProfile(userId, updated);
  } catch (e) {
    console.warn("[referral] failed to persist referral code:", e?.message || e);
  }
  return updated;
}

/**
 * Validate a referral code without side effects.
 * Returns { valid, referrer } — referrer is the sanitized owner profile.
 */
export async function validateReferralCode(storage, code, selfUserId = null) {
  const norm = String(code || "").trim();
  if (!norm) return { valid: false, reason: "empty" };
  const referrer = await storage.getProfileByReferralCode?.(norm);
  if (!referrer) return { valid: false, reason: "not_found" };
  // Anti-fraud: cannot refer yourself.
  if (selfUserId && String(referrer.id) === String(selfUserId)) {
    return { valid: false, reason: "self" };
  }
  return {
    valid: true,
    referrer: {
      id: referrer.id,
      name: referrer.name || null,
      role: referrer.role || null,
      referralCode: referrer.referralCode || norm,
    },
  };
}

/**
 * Record a permanent referral relationship for a newly-onboarded user.
 * Enforces anti-fraud rules: self-referral blocked, invalid codes rejected,
 * duplicate relationships blocked. Grants student->student rewards.
 * Returns { ok, reason?, referral? }.
 */
export async function recordReferral(storage, { referredUserId, referredProfile, code, source = "code" }) {
  const norm = String(code || "").trim();
  if (!norm) return { ok: false, reason: "empty" };

  // Already referred? (duplicate relationship blocked — permanent)
  const existing = await storage.getReferralByReferredUser?.(referredUserId);
  if (existing) return { ok: false, reason: "already_referred", referral: existing };

  const check = await validateReferralCode(storage, norm, referredUserId);
  if (!check.valid) return { ok: false, reason: check.reason };

  const referrer = check.referrer;
  const referral = await storage.addReferral({
    referrerId: String(referrer.id),
    referredUserId: String(referredUserId),
    referralCode: referrer.referralCode || norm,
    referrerRole: referrer.role || null,
    referredRole: referredProfile?.role || null,
    source,
    createdAt: new Date().toISOString(),
  });

  // Student -> Student: grant coins (and premium when hitting a 10-referral tier).
  if (referrer.role === "student") {
    await grantStudentReferralReward(storage, referrer.id);
  }

  return { ok: true, referral };
}

/**
 * Grant the student referrer their coins for a successful referral, and a
 * premium month every Nth referral.
 */
export async function grantStudentReferralReward(storage, referrerId) {
  await storage.addStudentReward?.({
    userId: String(referrerId),
    coins: COINS_PER_REFERRAL,
    premiumDays: 0,
    reason: "Successful referral",
  });
  // Count total referrals to check premium tier.
  const refs = (await storage.getReferralsByReferrer?.(referrerId)) || [];
  if (refs.length > 0 && refs.length % REFERRALS_PER_PREMIUM_MONTH === 0) {
    await storage.addStudentReward?.({
      userId: String(referrerId),
      coins: 0,
      premiumDays: PREMIUM_DAYS_PER_MONTH,
      reason: `${refs.length} referrals milestone — 1 month premium`,
    });
  }
}

/**
 * Create a PENDING commission when a referred buyer makes a successful purchase
 * and the referrer is a teacher (cash commission). No-op for student referrers
 * (they earn coins/premium at referral time, not on purchase) and self/unknown.
 * `purchaseAmount` is in INR (rupees). Idempotent per orderId.
 * Returns the created commission or null.
 */
export async function createCommissionForOrder(storage, { buyerId, orderId, purchaseAmount }) {
  if (!buyerId) return null;

  // Idempotency: never create two commissions for the same order.
  if (orderId) {
    const dup = await storage.getCommissionByOrderId?.(orderId);
    if (dup) return dup;
  }

  const referral = await storage.getReferralByReferredUser?.(buyerId);
  if (!referral) return null;

  // Anti-fraud: never pay commission on a self-referral.
  if (String(referral.referrerId) === String(buyerId)) return null;

  const referrer = await storage.getProfile?.(String(referral.referrerId));
  // Cash commission only for teacher referrers.
  if (!referrer || referrer.role !== "teacher") return null;

  const amount = Number(purchaseAmount) || 0;
  if (amount <= 0) return null;
  const commissionAmount = Math.round((amount * COMMISSION_PERCENT) / 100 * 100) / 100;

  return await storage.addCommission({
    referrerId: String(referral.referrerId),
    buyerId: String(buyerId),
    orderId: orderId || null,
    purchaseAmount: amount,
    commissionPercent: COMMISSION_PERCENT,
    commissionAmount,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
}

/** Cancel commission(s) for a refunded order. */
export async function cancelCommissionForOrder(storage, orderId) {
  if (!orderId) return null;
  const com = await storage.getCommissionByOrderId?.(orderId);
  if (!com || com.status === "paid") return com || null;
  return await storage.updateCommission(com.id, { status: "cancelled" });
}

/** Aggregate commission rows into pending/approved/paid/lifetime totals. */
export function summarizeCommissions(commissions = []) {
  const sum = { pending: 0, approved: 0, paid: 0, cancelled: 0, lifetime: 0 };
  for (const c of commissions) {
    const amt = Number(c.commissionAmount) || 0;
    if (c.status === "pending") sum.pending += amt;
    else if (c.status === "approved") sum.approved += amt;
    else if (c.status === "paid") sum.paid += amt;
    else if (c.status === "cancelled") sum.cancelled += amt;
    if (c.status !== "cancelled") sum.lifetime += amt;
  }
  for (const k of Object.keys(sum)) sum[k] = Math.round(sum[k] * 100) / 100;
  return sum;
}

/** Aggregate student reward rows into coins + premium day totals. */
export function summarizeRewards(rewards = []) {
  let coins = 0;
  let premiumDays = 0;
  for (const r of rewards) {
    coins += Number(r.coins) || 0;
    premiumDays += Number(r.premiumDays) || 0;
  }
  return { coins, premiumDays };
}
