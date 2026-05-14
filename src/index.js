import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { jsonStorage } from "./storage/json.js";
import { supabaseStorage } from "./storage/supabase.js";
import { buildAdminRouter } from "./admin-routes.js";

dotenv.config();

const PORT = parseInt(process.env.PORT || "4000", 10);
const storage = process.env.STORAGE === "supabase" ? supabaseStorage : jsonStorage;

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Seed the questions table on first boot (no-op if already populated).
storage.ensureSeed?.().catch((e) => console.warn("[seed] failed:", e));

// Simple user identifier — for the local prototype each browser is its own user.
// The client sends a generated userId in the `x-user-id` header. We just trust it
// for the local prototype. When you wire up Supabase Auth, swap this for a real
// JWT-verified user id.
function getUserId(req, res) {
  const uid = req.header("x-user-id");
  if (!uid) {
    res.status(400).json({ error: "Missing x-user-id header" });
    return null;
  }
  return uid;
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
app.get("/api/profile", async (req, res) => {
  const uid = getUserId(req, res);
  if (!uid) return;
  try {
    const profile = await storage.getProfile(uid);
    res.json({ profile });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put("/api/profile", async (req, res) => {
  const uid = getUserId(req, res);
  if (!uid) return;
  try {
    const saved = await storage.saveProfile(uid, req.body);
    res.json({ profile: saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Attempts ---
app.get("/api/attempts", async (req, res) => {
  const uid = getUserId(req, res);
  if (!uid) return;
  try {
    const attempts = await storage.getAttempts(uid);
    res.json({ attempts });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/attempts", async (req, res) => {
  const uid = getUserId(req, res);
  if (!uid) return;
  try {
    const saved = await storage.addAttempt(uid, req.body);
    res.json({ attempt: saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Papers ---
app.get("/api/papers", async (req, res) => {
  const uid = getUserId(req, res);
  if (!uid) return;
  try {
    const papers = await storage.getPapers(uid);
    res.json({ papers });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/papers", async (req, res) => {
  const uid = getUserId(req, res);
  if (!uid) return;
  try {
    const saved = await storage.addPaper(uid, req.body);
    res.json({ paper: saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete("/api/papers/:id", async (req, res) => {
  const uid = getUserId(req, res);
  if (!uid) return;
  try {
    await storage.deletePaper(uid, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Reset ---
app.post("/api/reset", async (req, res) => {
  const uid = getUserId(req, res);
  if (!uid) return;
  try {
    await storage.resetUser(uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[smartprep-server] listening on http://localhost:${PORT} (storage=${process.env.STORAGE || "json"})`);
});
