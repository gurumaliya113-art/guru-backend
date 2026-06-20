// =============================================================
//  User-facing Referral routes (mounted at /api/referral).
//  All routes except /validate require an authenticated session.
// =============================================================
import express from "express";
import {
  ensureReferralCode,
  validateReferralCode,
  summarizeCommissions,
  summarizeRewards,
} from "./referral.js";

const SIGNUP_BASE_URL = process.env.PUBLIC_SIGNUP_URL || "https://gurtron.in/signup";

export function buildReferralRouter(storage) {
  const r = express.Router();

  function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: "Authentication required" });
  }

  // Public: validate a referral code (used on the onboarding form).
  r.post("/validate", async (req, res) => {
    try {
      const { code } = req.body || {};
      const selfId = req.session?.user?.id || null;
      const result = await validateReferralCode(storage, code, selfId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // My referral code + share link + dashboard stats.
  r.get("/me", requireAuth, async (req, res) => {
    try {
      const userId = req.session.user.id.toString();
      let profile = (await storage.getProfile(userId)) || {};
      profile = await ensureReferralCode(storage, userId, profile);
      const code = profile.referralCode;

      const [referrals, commissions, rewards] = await Promise.all([
        storage.getReferralsByReferrer?.(userId) ?? [],
        storage.getCommissionsByReferrer?.(userId) ?? [],
        storage.getStudentRewardsByUser?.(userId) ?? [],
      ]);

      const teachersReferred = referrals.filter((x) => x.referredRole === "teacher").length;
      const studentsReferred = referrals.filter((x) => x.referredRole === "student").length;
      const commissionTotals = summarizeCommissions(commissions);
      const rewardTotals = summarizeRewards(rewards);

      res.json({
        referralCode: code,
        shareLink: `${SIGNUP_BASE_URL}?ref=${encodeURIComponent(code)}`,
        role: profile.role || "student",
        totals: {
          totalReferrals: referrals.length,
          teachersReferred,
          studentsReferred,
          ...commissionTotals,
          coins: rewardTotals.coins,
          premiumDays: rewardTotals.premiumDays,
        },
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Referral history (people I referred) + commission history.
  r.get("/history", requireAuth, async (req, res) => {
    try {
      const userId = req.session.user.id.toString();
      const [referrals, commissions, payouts, rewards] = await Promise.all([
        storage.getReferralsByReferrer?.(userId) ?? [],
        storage.getCommissionsByReferrer?.(userId) ?? [],
        storage.getPayoutsByUser?.(userId) ?? [],
        storage.getStudentRewardsByUser?.(userId) ?? [],
      ]);

      // Enrich referrals with the referred user's name / join date.
      const enriched = await Promise.all(
        referrals.map(async (ref) => {
          const p = await storage.getProfile?.(String(ref.referredUserId));
          return {
            id: ref.id,
            name: p?.name || "User",
            role: ref.referredRole || p?.role || "student",
            joinDate: ref.createdAt,
            status: "joined",
          };
        })
      );

      res.json({
        referrals: enriched,
        commissions: commissions.map((c) => ({
          id: c.id,
          orderId: c.orderId,
          purchaseAmount: c.purchaseAmount,
          commissionPercent: c.commissionPercent,
          commissionAmount: c.commissionAmount,
          status: c.status,
          date: c.createdAt,
        })),
        payouts,
        rewards,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  return r;
}
