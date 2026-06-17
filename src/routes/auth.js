import crypto from "crypto";
import express from "express";
import { OAuth2Client } from "google-auth-library";
import { jsonStorage } from "../storage/json.js";
import { supabaseStorage } from "../storage/supabase.js";
import { supabase } from "../supabase.js";
import { hashPassword, verifyPassword } from "../password.js";

const router = express.Router();
const storage = process.env.STORAGE === "supabase" && supabase ? supabaseStorage : jsonStorage;
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function sendAuthError(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

async function ensureProfile(userId, email, googleData = null) {
  const existingProfile = await storage.getProfile(userId);
  if (existingProfile) return existingProfile;

  const name = googleData?.name || email.split("@")[0] || "Student";
  const picture = googleData?.picture || null;

  const profile = {
    name,
    email,
    picture,
    role: "student",
    targetExam: "NEET",
    streak: 0,
    lastQuizDate: "",
    totalPoints: 0,
    badges: [],
    rank: 0,
    isOnboarded: false,
  };

  try {
    return await storage.saveProfile(userId, profile);
  } catch (error) {
    const message = String(error?.message || error || "").toLowerCase();
    if (message.includes("column \"email\" of relation \"profiles\" does not exist") || message.includes("column 'email'")) {
      const fallbackProfile = { ...profile };
      delete fallbackProfile.email;
      return await storage.saveProfile(userId, fallbackProfile);
    }
    throw error;
  }
}

// Google OAuth callback
router.post("/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return sendAuthError(res, "Invalid Google credential.");
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return sendAuthError(res, "Invalid Google token.");
    }

    const email = payload.email.trim().toLowerCase();
    
    // Check if user with this email already exists
    const existingProfile = await storage.getProfileByEmail(email);
    const userId = existingProfile?.id || `u_${crypto.randomBytes(6).toString("hex")}`;

    const profile = await ensureProfile(userId, email, {
      name: payload.name,
      picture: payload.picture,
    });

    req.session.user = {
      id: userId,
      email,
      name: profile.name,
      picture: profile.picture,
      role: profile.role,
    };

    res.json(req.session.user);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// Email/password signup. Password is hashed with scrypt and stored on the
// profile (`passwordHash` field) so we can verify it on subsequent logins.
router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return sendAuthError(res, "Email and password are required.");
    }
    if (String(password).length < 6) {
      return sendAuthError(res, "Password must be at least 6 characters.");
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if email already exists
    const existingProfile = await storage.getProfileByEmail(normalizedEmail);
    if (existingProfile) {
      return sendAuthError(res, "Email is already in use.", 409);
    }

    const userId = `u_${crypto.randomBytes(6).toString("hex")}`;
    const profile = await ensureProfile(userId, normalizedEmail);

    // Persist hashed password on the profile.
    const passwordHash = hashPassword(password);
    await storage.saveProfile(userId, { ...profile, passwordHash });

    req.session.user = {
      id: userId,
      email: normalizedEmail,
      name: profile.name,
      picture: profile.picture,
      role: profile.role,
    };

    res.json(req.session.user);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

// Email/Phone/Username + password login.
// Accepts `identifier` (preferred) or legacy `email`.
router.post("/login", async (req, res) => {
  try {
    const { identifier, email, password } = req.body || {};
    const id = (identifier ?? email ?? "").toString().trim();
    if (!id || !password) {
      return sendAuthError(res, "Login ID and password are required.");
    }

    // Multi-identifier lookup: email / username / phone
    let userProfile = null;
    if (typeof storage.getProfileByIdentifier === "function") {
      userProfile = await storage.getProfileByIdentifier(id);
    }
    if (!userProfile) {
      userProfile = await storage.getProfileByEmail(id);
    }
    if (!userProfile) {
      return sendAuthError(res, "Invalid login ID or password.", 401);
    }

    // Verify password against the stored scrypt hash. If the user has no hash
    // yet (legacy account or Google-only account), we refuse the password
    // login so a guessable email can't hijack them — they must use Google or
    // reset their password via the onboarding form.
    if (!userProfile.passwordHash) {
      return sendAuthError(
        res,
        "This account has no password set. Sign in with Google, or register again to set a password.",
        401
      );
    }
    if (!verifyPassword(password, userProfile.passwordHash)) {
      return sendAuthError(res, "Invalid login ID or password.", 401);
    }

    const profile = await ensureProfile(userProfile.id, userProfile.email || id);

    req.session.user = {
      id: userProfile.id,
      email: userProfile.email || profile.email || null,
      name: profile.name,
      picture: profile.picture,
      role: profile.role,
    };

    res.json(req.session.user);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

router.get("/me", (req, res) => {
  if (req.session?.user) {
    res.json(req.session.user);
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Logout failed" });
    }
    res.json({ message: "Logged out successfully" });
  });
});

// Dev-only: quickly set session for a seeded user (useful in local development).
// Usage: POST /auth/dev-login { userId } or { email }
if (process.env.NODE_ENV !== "production") {
  router.post("/dev-login", async (req, res) => {
    try {
      console.log("[dev-login] payload:", req.body);
      const { userId, email } = req.body || {};
      let profile = null;
      let sessionUserId = null;
      if (userId) {
        profile = await storage.getProfile(userId);
        sessionUserId = userId;
      }
      if (!profile && email) {
        const found = await storage.getProfileByEmail(String(email).trim().toLowerCase());
        if (found) {
          sessionUserId = found.id || found.userId || null;
          if (sessionUserId) profile = await storage.getProfile(sessionUserId);
        }
      }
      if (!profile) return res.status(404).json({ error: "User not found" });
      console.log("[dev-login] found profile for sessionId=", sessionUserId, "profileKeys=", Object.keys(profile || {}));
      req.session.user = {
        id: sessionUserId || userId,
        email: profile.email || email || null,
        name: profile.name || null,
        picture: profile.picture || null,
        role: profile.role || "student",
      };
      res.json(req.session.user);
    } catch (error) {
      console.error("[dev-login] error:", error && error.stack ? error.stack : error);
      res.status(500).json({ error: String(error?.message || error) });
    }
  });
}

router.patch("/users/:id/role", async (req, res) => {
  try {
    const { role } = req.body;
    if (!["student", "teacher", "admin"].includes(role)) {
      return res.status(400).json({ error: "Invalid role" });
    }

    const supabase = await loadSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase
        .from("profiles")
        .update({ role })
        .eq("id", req.params.id)
        .select()
        .single();

      if (error) {
        return res.status(500).json({ error: "Failed to update user role" });
      }

      if (!data) {
        return res.status(404).json({ error: "User not found" });
      }

      return res.json(data);
    }

    const profile = await storage.getProfile(req.params.id);
    if (!profile) {
      return res.status(404).json({ error: "User not found" });
    }
    profile.role = role;
    const updated = await storage.saveProfile(req.params.id, profile);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: "Failed to update user role" });
  }
});

router.get("/users", async (req, res) => {
  try {
    const supabase = await loadSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase.from("profiles").select("*");
      if (error) {
        return res.status(500).json({ error: "Failed to fetch users" });
      }
      return res.json(data);
    }

    const profiles = await jsonStorage.getAllProfiles();
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

router.get("/users/by-email", async (req, res) => {
  try {
    const email = req.query.email?.toString();
    if (!email) {
      return res.status(400).json({ error: "Missing email query." });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const supabase = await loadSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase
        .from("profiles")
        .select("*")
        .eq("email", normalizedEmail)
        .single();
      if (error) {
        if (error.code === "PGRST116") {
          return res.status(404).json({ error: "User not found." });
        }
        return res.status(500).json({ error: "Failed to fetch user by email" });
      }
      return res.json(data);
    }

    const account = await jsonStorage.findAccountByEmail(normalizedEmail);
    if (!account) {
      return res.status(404).json({ error: "User not found." });
    }
    const profile = await storage.getProfile(account.userId);
    res.json(profile || {});
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

export default router;
