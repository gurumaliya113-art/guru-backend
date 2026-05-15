import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import session from "express-session";
import authRoutes from "./routes/auth.js";
import { jsonStorage } from "./storage/json.js";
import { supabaseStorage } from "./storage/supabase.js";
import { buildAdminRouter } from "./admin-routes.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const storage = process.env.STORAGE === "supabase" ? supabaseStorage : jsonStorage;

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true
}));
app.use(express.json({ limit: "5mb" }));

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET || "your-secret-key-change-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Auth routes
app.use("/auth", authRoutes);

// Seed the questions table on first boot (no-op if already populated).
storage.ensureSeed?.().catch((e) => console.warn("[seed] failed:", e));

// User authentication middleware
function requireAuth(req, res, next) {
  if (req.session?.user) {
    return next();
  }
  res.status(401).json({ error: "Authentication required" });
}

// Get current authenticated user
function getCurrentUser(req, res) {
  if (!req.session?.user) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  return req.session.user;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, storage: process.env.STORAGE || "json" });
});

// Public: read-only questions catalogue used by the student app (quizzes, paper gen).
app.get("/api/questions", async (_req, res) => {
  try {
    const questions = await storage.getQuestions();
    res.json({ questions });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Admin routes (login, stats, questions CRUD, PDF parse)
app.use("/api/admin", buildAdminRouter(storage));

// --- Profile ---
app.get("/api/profile", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const profile = await storage.getProfile(user.id.toString());
    res.json({ profile });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put("/api/profile", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const saved = await storage.saveProfile(user.id.toString(), req.body);
    res.json({ profile: saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Attempts ---
app.get("/api/attempts", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const attempts = await storage.getAttempts(user.id.toString());
    res.json({ attempts });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/attempts", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const saved = await storage.addAttempt(user.id.toString(), req.body);
    res.json({ attempt: saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Papers ---
app.get("/api/papers", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const papers = await storage.getPapers(user.id.toString());
    res.json({ papers });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/papers", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const saved = await storage.addPaper(user.id.toString(), req.body);
    res.json({ paper: saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete("/api/papers/:id", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    await storage.deletePaper(user.id.toString(), req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Reset ---
app.post("/api/reset", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    await storage.resetUser(user.id.toString());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[smartprep-server] listening on http://localhost:${PORT} (storage=${process.env.STORAGE || "json"})`);
});
