import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

import express from "express";
import cors from "cors";
import session from "express-session";
import crypto from "crypto";
import multer from "multer";
import Groq from "groq-sdk";
import { supabase } from "./supabase.js";
import authRoutes from "./routes/auth.js";
import { jsonStorage } from "./storage/json.js";
import { supabaseStorage } from "./storage/supabase.js";
import { buildAdminRouter } from "./admin-routes.js";
import { buildReferralRouter } from "./referral-routes.js";
import { createCommissionForOrder, ensureReferralCode, recordReferral } from "./referral.js";
import { getPageImageBytes, getFigureImageBytes, getPdfBytes, savePageImage } from "./storage/pdf-storage.js";
import { renderPagesToPng } from "./parsers/pdf-render.js";
import { saveCaptureImage, CAPTURES_LOCAL_DIR } from "./storage/capture-storage.js";
import { hashPassword } from "./password.js";
import { answerWithGemini } from "./parsers/gemini.js";
import fs from "fs";

const PORT = parseInt(process.env.PORT || "4000", 10);
// Prefer Supabase when explicitly configured AND the client initialized;
// otherwise fall back to local JSON storage so the server remains operational.
let storage;
if (process.env.STORAGE === "supabase") {
  if (supabase) {
    storage = supabaseStorage;
  } else {
    console.warn("[startup] STORAGE=supabase but Supabase client failed to initialize — falling back to json storage.");
    storage = jsonStorage;
  }
} else {
  storage = jsonStorage;
}

const app = express();
// CORS: allow comma-separated origins via FRONTEND_URL or CLIENT_ORIGIN.
// Example: FRONTEND_URL="https://frontend-two.vercel.app,http://localhost:5173"
const defaultLocalOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4173",
  "http://127.0.0.1:3000",
];
const allowedOrigins = (process.env.FRONTEND_URL || process.env.CLIENT_ORIGIN || defaultLocalOrigins.join(","))
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean)
  .concat(defaultLocalOrigins);
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin / curl (no origin header)
    if (!origin) return cb(null, true);
    // Allow any localhost origin (different dev ports)
    try {
      const u = new URL(origin);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return cb(null, true);
    } catch (e) {}
    // Allow explicit whitelist
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Reject CORS properly (don't throw error which becomes 500)
    cb(null, false);
  },
  credentials: true,
}));
// Ensure preflight allows the custom admin token header used by the frontend
// (x-admin-token) so browsers can send it in multipart/form-data uploads.
app.options('*', cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    try { const u = new URL(origin); if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return cb(null, true); } catch (e) {}
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','x-admin-token','Authorization'],
}));
app.use(express.json({ limit: "5mb" }));

// Session middleware. When frontend and backend live on different origins
// (Vercel ↔ Render), cookies must be SameSite=None and Secure=true so the
// browser sends them on cross-site fetches with credentials.
const isProd = process.env.NODE_ENV === "production";
app.set("trust proxy", 1); // required on Render/Heroku-style proxies for Secure cookies
app.use(session({
  secret: process.env.SESSION_SECRET || "your-secret-key-change-in-production",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    httpOnly: true,
    // Use SameSite=None in production for cross-site deployments; use lax in
    // local development so browsers accept the cookie without requiring Secure.
    sameSite: isProd ? "none" : "lax",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
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
  res.json({
    ok: true,
    storage: process.env.STORAGE || "json",
    // Boolean presence flags only (never the secret values) so we can verify
    // which keys the RUNNING backend actually sees in its environment.
    env: {
      geminiKey: !!process.env.GEMINI_API_KEY,
      geminiKey2: !!process.env.GEMINI_API_KEY_2,
      groqKey: !!(process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_CHAT),
      razorpay: !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
      nodeEnv: process.env.NODE_ENV || "(unset)",
    },
  });
});

// --- Learning routes: notes, tests, rankings, chat ---
app.get("/api/notes", async (req, res) => {
  try {
    const notes = await storage.getNotes(req.query || {});
    res.json({ notes });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/notes/:id", async (req, res) => {
  try {
    const note = await storage.getNote(req.params.id);
    if (!note) return res.status(404).json({ error: "Note not found" });
    res.json({ note });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/notes", requireAuth, async (req, res) => {
  try {
    const saved = await storage.addNote(req.body || {});
    res.json({ note: saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/tests", async (req, res) => {
  try {
    const tests = await storage.getTests(req.query || {});
    res.json({ tests });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/tests/:id", async (req, res) => {
  try {
    const test = await storage.getTest(req.params.id);
    if (!test) return res.status(404).json({ error: "Test not found" });
    res.json({ test });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/tests", requireAuth, async (req, res) => {
  try {
    const saved = await storage.addTest(req.body || {});
    res.json({ test: saved });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Simple leaderboard aggregation from scores stored under `attempts`
app.get("/api/rankings", async (req, res) => {
  try {
    const scope = req.query.scope || "national"; // class|city|state|national
    const limit = parseInt(req.query.limit || "50", 10);
    const db = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "db.json"), "utf-8"));
    const attempts = db.attempts || {};
    const profiles = db.users || {};

    // Flatten attempts into array of { userId, score }
    const flat = Object.entries(attempts).flatMap(([userId, list]) => (list || []).map((a) => ({ userId, score: Number(a.score || 0) })));
    const byUser = {};
    for (const a of flat) {
      byUser[a.userId] = Math.max(byUser[a.userId] || 0, a.score || 0);
    }

    // Build list of users with profile metadata
    let users = Object.entries(byUser).map(([userId, score]) => ({ userId, score, profile: profiles[userId] || null }));

    // Apply scope filters
    const classId = req.query.classId;
    const city = req.query.city;
    const stateQ = req.query.state;

    if (scope === "class" && classId) {
      users = users.filter((u) => u.profile && String(u.profile.classLevel || u.profile.classId || "") === String(classId));
    } else if (scope === "city" && city) {
      users = users.filter((u) => u.profile && String(u.profile.city || "").toLowerCase() === String(city).toLowerCase());
    } else if (scope === "state" && stateQ) {
      users = users.filter((u) => u.profile && String(u.profile.state || "").toLowerCase() === String(stateQ).toLowerCase());
    }

    users.sort((a, b) => b.score - a.score);
    const limited = users.slice(0, limit).map((u, i) => ({ rank: i + 1, userId: u.userId, score: u.score, name: u.profile?.name || null }));
    res.json({ rankings: limited });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Simple AI chat that searches notes and questions for context and returns a stubbed reply.
app.post("/api/chat", async (req, res) => {
  try {
    const message = String((req.body || {}).message || "").trim();
    if (!message) return res.status(400).json({ error: "Message is required" });
    const db = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "db.json"), "utf-8"));
    const notes = db.notes || [];
    const questions = db.questions || [];
    // naive context matching: look for keywords in notes/questions
    const q = message.toLowerCase();
    const matchedNotes = notes.filter((n) => (n.title || "").toLowerCase().includes(q) || (n.content || "").toLowerCase().includes(q)).slice(0, 5);
    const matchedQs = questions.filter((qq) => (qq.text || "").toLowerCase().includes(q)).slice(0, 5);
    // Respond with a simple templated reply and source ids
    const reply = `I found ${matchedNotes.length} notes and ${matchedQs.length} questions that might help. Ask me to summarise any.`;
    const sources = { notes: matchedNotes.map((n) => n.id), questions: matchedQs.map((q) => q.id) };
    res.json({ reply, sources });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Public: read-only topics catalogue. The admin manages topics via the admin
// panel; the teacher's Paper Generation flow reads from the same source so
// both stay in sync without any client-side duplication.
app.get("/api/topics", async (_req, res) => {
  try {
    const topics = (await storage.getTopics?.()) || [];
    res.json({ topics });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
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

app.get("/api/flashcards", async (_req, res) => {
  try {
    const flashcards = (await storage.getFlashcards?.()) || [];
    res.json({ flashcards });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Public: serve PDF page snapshots (diagrams) for figure-questions.
// No auth — these are needed by both admin review and student app.
app.get("/api/documents/:id/pages/:n.png", async (req, res) => {
  try {
    const docId = req.params.id;
    const pageNumber = parseInt(req.params.n, 10);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return res.status(400).json({ error: "Invalid page number" });
    }
    const doc = await storage.getDocument?.(docId);
    const backend = doc?.storageBackend || (process.env.STORAGE === "supabase" ? "supabase" : "local");
    let buf;
    try {
      // Fast path: a page snapshot was already saved (during parse).
      buf = await getPageImageBytes({ docId, pageNumber, backend });
    } catch {
      // On-demand fallback: the snapshot wasn't saved, but the source PDF is
      // stored. Render just this page from the PDF so the admin can still open
      // it and crop a diagram, then cache it for next time.
      if (!doc || !doc.storagePath) throw new Error("Page image not found");
      const pdfBuf = await getPdfBytes(doc.storagePath, doc.storageBackend);
      const scale = Number(process.env.PDF_RENDER_SCALE || 2);
      const rendered = await renderPagesToPng(pdfBuf, [pageNumber], scale);
      buf = rendered.get(pageNumber);
      if (!buf) throw new Error("Page image not found");
      // Best-effort cache so subsequent loads are instant.
      try { await savePageImage({ docId, pageNumber, buffer: buf }); } catch (e) {
        console.warn("[pages] cache save failed:", e.message);
      }
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (e) {
    res.status(404).json({ error: String(e.message || e) });
  }
});

// Public: serve per-question figure crops (diagrams cropped out of a page).
app.get("/api/documents/:id/figures/:name.png", async (req, res) => {
  try {
    const docId = req.params.id;
    const name = req.params.name;
    const doc = await storage.getDocument?.(docId);
    const backend = doc?.storageBackend || (process.env.STORAGE === "supabase" ? "supabase" : "local");
    const buf = await getFigureImageBytes({ docId, name, backend });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (e) {
    res.status(404).json({ error: String(e.message || e) });
  }
});

// Admin routes (login, stats, questions CRUD, PDF parse)
app.use("/api/admin", buildAdminRouter(storage));

// Referral & Commission routes (user-facing)
app.use("/api/referral", buildReferralRouter(storage));

// --- Profile ---
function sanitizeProfile(profile) {
  if (!profile) return profile;
  const { passwordHash, password_hash, ...rest } = profile;
  return rest;
}

app.get("/api/profile", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const profile = await storage.getProfile(user.id.toString());
    res.json({ profile: sanitizeProfile(profile) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.put("/api/profile", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const incoming = { ...(req.body || {}) };
    const rawPassword = incoming.password;
    // Referral code the user is claiming they were referred by (optional).
    const referredByCode = incoming.referredByCode;
    delete incoming.referredByCode;
    // Never persist the raw password in the profile.
    delete incoming.password;
    // Don't let a client clobber the stored hash directly.
    delete incoming.passwordHash;

    if (rawPassword) {
      if (typeof rawPassword !== "string" || rawPassword.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
      }
      incoming.passwordHash = hashPassword(rawPassword);
    }

    // Fetch existing profile and merge so server-managed / non-editable fields
    // (email, picture, existing passwordHash) survive partial updates from the
    // client. Without this, a single PUT from Onboarding would wipe out the
    // signup-time email + password hash, breaking subsequent password logins.
    const existing = (await storage.getProfile(user.id.toString())) || {};

    const merged = {
      ...existing,
      ...incoming,
      // Always retain identity / auth fields from the existing profile unless
      // the client is explicitly setting a new password (already hashed above).
      email: incoming.email || existing.email,
      passwordHash: incoming.passwordHash || existing.passwordHash,
    };

    let saved = await storage.saveProfile(user.id.toString(), merged);

    // Ensure the user has their own unique referral code.
    saved = await ensureReferralCode(storage, user.id.toString(), saved);

    // If they entered a referral code, record the (permanent) relationship.
    // Best-effort: invalid/self/duplicate codes are silently ignored so they
    // never block onboarding.
    if (referredByCode) {
      try {
        const result = await recordReferral(storage, {
          referredUserId: user.id.toString(),
          referredProfile: saved,
          code: referredByCode,
          source: "code",
        });
        if (result.ok && result.referral) {
          saved = await storage.saveProfile(user.id.toString(), {
            ...saved,
            referredBy: result.referral.referralCode,
          });
        }
      } catch (err) {
        console.warn("[referral] recordReferral failed:", err?.message || err);
      }
    }

    res.json({ profile: sanitizeProfile(saved) });
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

// Start a test attempt (creates a started attempt row)
app.post("/api/tests/:id/start", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const test = await storage.getTest(req.params.id);
    if (!test) return res.status(404).json({ error: "Test not found" });
    const attempt = {
      id: `a_${Date.now()}`,
      quizId: test.id,
      title: test.title || "Quiz",
      startedAt: new Date().toISOString(),
      status: "started",
      answers: {},
    };
    await storage.addAttempt(user.id.toString(), attempt);
    res.json({ attempt });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Submit a finished test attempt (compute score and persist)
app.post("/api/tests/:id/submit", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const test = await storage.getTest(req.params.id);
    if (!test) return res.status(404).json({ error: "Test not found" });
    const payload = req.body || {};
    const answers = payload.answers || {};
    const allQuestions = (await storage.getQuestions()) || [];
    const qmap = Object.fromEntries(allQuestions.map((q) => [q.id, q]));
    let score = 0;
    const total = Array.isArray(test.questionIds) ? test.questionIds.length : Object.keys(answers).length;
    for (const [qid, sel] of Object.entries(answers)) {
      const q = qmap[qid];
      if (!q) continue;
      if (Number(sel) === Number(q.correctIndex)) score++;
    }

    const attempt = {
      id: payload.id || `a_${Date.now()}`,
      quizId: test.id,
      title: test.title || "Quiz",
      startedAt: payload.startedAt || null,
      finishedAt: new Date().toISOString(),
      status: "finished",
      answers,
      score,
      totalQuestions: total,
      timeSpent: payload.timeSpent || null,
      date: new Date().toISOString(),
    };
    await storage.addAttempt(user.id.toString(), attempt);
    res.json({ attempt });
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

// ---- Captured-paper upload (teacher snaps photos of handwritten /
// printed questions and turns them into an image-only paper). The paper
// row stored here is a regular `papers` row — we just stash each image as
// a synthetic "question" with `pageImageUrl` set and `options=[]`. That
// way the entire downstream pipeline (assignment, student feed, PaperView,
// print/PDF) keeps working without any other code changes.
const captureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 20 }, // 8 MB / image, max 20 images
  fileFilter: (_req, file, cb) => {
    if ((file.mimetype || "").startsWith("image/")) return cb(null, true);
    cb(new Error("Only image uploads are allowed"));
  },
});

app.post(
  "/api/papers/capture",
  requireAuth,
  captureUpload.array("images", 20),
  async (req, res) => {
    const user = getCurrentUser(req, res);
    if (!user) return;
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length === 0) {
        return res.status(400).json({ error: "At least one image is required" });
      }
      const title = String(req.body.title || "").trim() || "Captured paper";
      const examType = String(req.body.examType || "Board").trim();
      const subject = String(req.body.subject || "").trim();
      const topic = String(req.body.topic || "All").trim() || "All";
      const difficulty = String(req.body.difficulty || "Moderate").trim();

      const paperId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      // Upload every image in parallel.
      const urls = await Promise.all(
        files.map((f, i) =>
          saveCaptureImage({
            paperId,
            index: i,
            buffer: f.buffer,
            mimetype: f.mimetype,
          })
        )
      );

      // Synthesize one image-only "question" per uploaded photo so the
      // existing PaperView + print/PDF flow renders them automatically.
      const questions = urls.map((url, i) => ({
        id: `${paperId}_q${i + 1}`,
        text: "",
        options: [],
        correctIndex: 0,
        topic: topic || "All",
        difficulty: difficulty || "Moderate",
        explanation: "",
        pageImageUrl: url,
        subject: subject || "",
        examType: examType || "Board",
      }));

      const paper = {
        id: paperId,
        title,
        examType,
        subject,
        topic,
        difficulty,
        questions,
        createdAt: new Date().toISOString(),
      };

      const saved = await storage.addPaper(user.id.toString(), paper);
      res.json({ paper: saved || paper });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  }
);

// Multer error handler scoped just to the capture upload — catches "file
// too big" / "wrong mime" so the client gets a clean JSON error.
app.use("/api/papers/capture", (err, _req, res, next) => {
  if (err) return res.status(400).json({ error: String(err.message || err) });
  next();
});

// Static-serve locally-stored capture images when STORAGE !== "supabase".
// On Supabase mode, images are served directly from the public bucket URL.
app.use(
  "/api/captures",
  express.static(CAPTURES_LOCAL_DIR, {
    fallthrough: true,
    maxAge: "1y",
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === ".png" ? "image/png"
        : ext === ".webp" ? "image/webp"
        : ext === ".gif" ? "image/gif"
        : "image/jpeg";
      res.setHeader("Content-Type", mime);
    },
  })
);

// Fetch a single paper by id. Authorized for:
//   1) the teacher who owns the paper, OR
//   2) any student with an APPROVED membership in a class to which this
//      paper has been assigned.
// Without this, students hitting /paper/:id (from the assignments feed)
// would see "Paper not found" because their local cache only contains
// papers they themselves authored.
app.get("/api/papers/:id", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const paper = await storage.getPaperById(req.params.id);
    if (!paper) return res.status(404).json({ error: "Paper not found" });

    const userId = user.id.toString();
    const ownerId = (paper.userId || paper.user_id || "").toString();
    if (ownerId === userId) {
      return res.json({ paper });
    }

    // Student path: check membership ↔ assignment overlap.
    const [assignments, memberships] = await Promise.all([
      storage.getAssignmentsByPaper(req.params.id),
      storage.getMembershipsByStudent(userId),
    ]);
    const approvedClassIds = new Set(
      memberships.filter((m) => m.status === "approved").map((m) => m.classId)
    );
    const hasAccess = assignments.some((a) => approvedClassIds.has(a.classId));
    if (!hasAccess) return res.status(403).json({ error: "Not allowed" });

    res.json({ paper });
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

// --- Classes & Memberships ---
function genCode(classLevel, batchType, subject) {
  const subjInit = (subject || "X").trim().charAt(0).toUpperCase() || "X";
  const batchLetter = batchType === "toppers" ? "T" : "N";
  const rand = Math.floor(100 + Math.random() * 900); // 3-digit
  return `${classLevel}${batchLetter}-${subjInit}${rand}`;
}

async function uniqueCode(classLevel, batchType, subject) {
  for (let i = 0; i < 20; i++) {
    const code = genCode(classLevel, batchType, subject);
    const existing = await storage.getClassByCode(code);
    if (!existing) return code;
  }
  // fallback: add timestamp tail
  return `${classLevel}${batchType === "toppers" ? "T" : "N"}-${Date.now().toString(36).slice(-5).toUpperCase()}`;
}

// Teacher: list own classes
app.get("/api/classes/mine", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const classes = await storage.getClassesByTeacher(user.id.toString());
    res.json({ classes });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Teacher: create a class
app.post("/api/classes", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const { name, subject, classLevel, batchType, school, teacherName } = req.body || {};
    if (!name || !classLevel || !batchType) {
      return res.status(400).json({ error: "name, classLevel and batchType are required" });
    }
    if (!["toppers", "normal"].includes(batchType)) {
      return res.status(400).json({ error: "batchType must be 'toppers' or 'normal'" });
    }
    const code = await uniqueCode(classLevel, batchType, subject || name);
    const cls = {
      id: `cls_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      code,
      name: String(name).trim(),
      subject: subject ? String(subject).trim() : "",
      classLevel: String(classLevel),
      batchType,
      school: school ? String(school).trim() : "",
      teacherId: user.id.toString(),
      teacherName: teacherName ? String(teacherName).trim() : (user.name || ""),
      createdAt: new Date().toISOString(),
    };
    await storage.addClass(cls);
    res.json({ class: cls });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Public lookup: student needs to see class info before confirming join
app.get("/api/classes/by-code/:code", async (req, res) => {
  try {
    const cls = await storage.getClassByCode(req.params.code);
    if (!cls) return res.status(404).json({ error: "Class not found" });
    // Return safe public projection
    res.json({
      class: {
        id: cls.id,
        code: cls.code,
        name: cls.name,
        subject: cls.subject,
        classLevel: cls.classLevel,
        batchType: cls.batchType,
        school: cls.school,
        teacherName: cls.teacherName,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Teacher: list memberships for a class (with approval status)
app.get("/api/classes/:id/memberships", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const cls = await storage.getClass(req.params.id);
    if (!cls) return res.status(404).json({ error: "Class not found" });
    if (cls.teacherId !== user.id.toString()) {
      return res.status(403).json({ error: "Not your class" });
    }
    const memberships = await storage.getMembershipsByClass(cls.id);
    res.json({ memberships });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Teacher: aggregated stats for a class (per-student summary + class totals).
// Authorized: only the owning teacher.
app.get("/api/classes/:id/stats", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const cls = await storage.getClass(req.params.id);
    if (!cls) return res.status(404).json({ error: "Class not found" });
    if (cls.teacherId !== user.id.toString()) {
      return res.status(403).json({ error: "Not your class" });
    }
    const memberships = await storage.getMembershipsByClass(cls.id);
    const approved = memberships.filter((m) => m.status === "approved");

    const round = (n) => Math.round(n);
    const students = [];
    let classQuizzes = 0;
    let classScoreSum = 0; // sum of percentages across all attempts
    let classAttemptCount = 0;

    for (const m of approved) {
      const sid = String(m.studentId || "");
      let attempts = [];
      try { attempts = sid ? await storage.getAttempts(sid) : []; } catch { attempts = []; }
      const count = attempts.length;
      const pcts = attempts.map((a) => (a.totalQuestions ? (a.score / a.totalQuestions) * 100 : 0));
      const avg = count ? pcts.reduce((s, p) => s + p, 0) / count : 0;
      const best = count ? Math.max(...pcts) : 0;
      const lastDate = count ? attempts.map((a) => a.date).filter(Boolean).sort().slice(-1)[0] : null;

      classQuizzes += count;
      classScoreSum += pcts.reduce((s, p) => s + p, 0);
      classAttemptCount += count;

      students.push({
        studentId: sid,
        membershipId: m.id,
        name: m.studentName || "Student",
        rollNumber: m.rollNumber || "",
        parentPhone: m.parentPhone || "",
        quizzes: count,
        avgScore: round(avg),
        bestScore: round(best),
        lastActive: lastDate,
      });
    }

    // Strongest first by avg score.
    students.sort((a, b) => b.avgScore - a.avgScore);

    res.json({
      class: {
        id: cls.id, name: cls.name, code: cls.code, classLevel: cls.classLevel,
        batchType: cls.batchType, subject: cls.subject, school: cls.school,
      },
      summary: {
        totalStudents: approved.length,
        pending: memberships.filter((m) => m.status === "pending").length,
        totalQuizzes: classQuizzes,
        classAvgScore: classAttemptCount ? round(classScoreSum / classAttemptCount) : 0,
      },
      students,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Teacher: full quiz/mock records of one student in their class.
// Authorized: owning teacher AND the student must be a member of the class.
app.get("/api/classes/:id/students/:studentId/attempts", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const cls = await storage.getClass(req.params.id);
    if (!cls) return res.status(404).json({ error: "Class not found" });
    if (cls.teacherId !== user.id.toString()) {
      return res.status(403).json({ error: "Not your class" });
    }
    const sid = String(req.params.studentId || "");
    const memberships = await storage.getMembershipsByClass(cls.id);
    const membership = memberships.find((m) => String(m.studentId) === sid);
    if (!membership) {
      return res.status(404).json({ error: "Student is not a member of this class" });
    }
    let attempts = [];
    try { attempts = await storage.getAttempts(sid); } catch { attempts = []; }
    // Newest first.
    attempts.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    res.json({
      student: {
        studentId: sid,
        name: membership.studentName || "Student",
        rollNumber: membership.rollNumber || "",
        parentPhone: membership.parentPhone || "",
      },
      attempts,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.patch("/api/memberships/:id", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const { status } = req.body || {};
    if (!["approved", "rejected", "pending"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const all = await storage.getMemberships();
    const m = all.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: "Membership not found" });
    const cls = await storage.getClass(m.classId);
    if (!cls || cls.teacherId !== user.id.toString()) {
      return res.status(403).json({ error: "Not your class" });
    }
    const updated = await storage.updateMembership(m.id, {
      status,
      decidedAt: new Date().toISOString(),
    });
    res.json({ membership: updated });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Student: get own memberships (to know current/pending class)
app.get("/api/memberships/mine", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const memberships = await storage.getMembershipsByStudent(user.id.toString());
    // Attach class info for convenience
    const withClasses = await Promise.all(
      memberships.map(async (m) => ({
        ...m,
        class: await storage.getClass(m.classId),
      }))
    );
    res.json({ memberships: withClasses });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Student: join a class by code
app.post("/api/memberships", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const { code, studentName, rollNumber, parentPhone } = req.body || {};
    if (!code || !studentName || !rollNumber) {
      return res.status(400).json({ error: "code, studentName and rollNumber are required" });
    }
    const cls = await storage.getClassByCode(code);
    if (!cls) return res.status(404).json({ error: "Class not found" });

    // Prevent duplicate join (any non-rejected membership for this student/class)
    const mine = await storage.getMembershipsByStudent(user.id.toString());
    const dup = mine.find((m) => m.classId === cls.id && m.status !== "rejected");
    if (dup) {
      return res.json({ membership: { ...dup, class: cls } });
    }

    const m = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      classId: cls.id,
      studentId: user.id.toString(),
      studentName: String(studentName).trim(),
      rollNumber: String(rollNumber).trim(),
      parentPhone: parentPhone ? String(parentPhone).trim() : "",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await storage.addMembership(m);
    res.json({ membership: { ...m, class: cls } });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Assignments (teacher assigns paper to a class) ---

// List my assignments (assigned by me OR for classes I teach). For now we keep
// it simple: return everything I assigned.
app.get("/api/assignments/mine", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const all = await storage.getAssignments();
    const mine = all.filter((a) => a.assignedBy === user.id.toString());
    res.json({ assignments: mine });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// List assignments for a class — teacher of that class can view.
app.get("/api/classes/:id/assignments", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const cls = await storage.getClass(req.params.id);
    if (!cls) return res.status(404).json({ error: "Class not found" });
    if (cls.teacherId !== user.id.toString()) {
      return res.status(403).json({ error: "Not your class" });
    }
    const assignments = await storage.getAssignmentsByClass(cls.id);
    res.json({ assignments });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Assign a paper to a class.
app.post("/api/papers/:paperId/assign", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const { classId } = req.body || {};
    if (!classId) return res.status(400).json({ error: "classId is required" });

    const cls = await storage.getClass(classId);
    if (!cls) return res.status(404).json({ error: "Class not found" });
    if (cls.teacherId !== user.id.toString()) {
      return res.status(403).json({ error: "Not your class" });
    }

    // Paper must belong to this teacher.
    const myPapers = await storage.getPapers(user.id.toString());
    const paper = myPapers.find((p) => p.id === req.params.paperId);
    if (!paper) return res.status(404).json({ error: "Paper not found" });

    // De-duplicate: don't create another row if already assigned.
    const existing = await storage.getAssignmentsByClass(cls.id);
    const dup = existing.find((a) => a.paperId === paper.id);
    if (dup) return res.json({ assignment: dup, alreadyAssigned: true });

    const assignment = {
      id: `asn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      paperId: paper.id,
      paperTitle: paper.title,
      classId: cls.id,
      classCode: cls.code,
      className: cls.name,
      assignedBy: user.id.toString(),
      assignedAt: new Date().toISOString(),
    };
    await storage.addAssignment(assignment);
    res.json({ assignment });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Unassign (delete).
app.delete("/api/assignments/:id", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const all = await storage.getAssignments();
    const a = all.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: "Assignment not found" });
    if (a.assignedBy !== user.id.toString()) {
      return res.status(403).json({ error: "Not your assignment" });
    }
    await storage.deleteAssignment(a.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Student: list papers assigned to me (via my approved memberships).
// We hydrate each row with the assigning teacher's display name so the
// home-feed can render "Manoj sir uploaded …" without an extra round-trip.
app.get("/api/assignments/for-me", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const mems = await storage.getMembershipsByStudent(user.id.toString());
    const approved = mems.filter((m) => m.status === "approved");
    if (approved.length === 0) return res.json({ assignments: [] });

    const all = await storage.getAssignments();
    const myClassIds = new Set(approved.map((m) => m.classId));
    const mine = all.filter((a) => myClassIds.has(a.classId));

    // Resolve assigning teacher names. Cache per teacher so we don't hit
    // storage repeatedly when one teacher has many assignments.
    const nameCache = new Map();
    const hydrated = await Promise.all(
      mine.map(async (a) => {
        if (!a.assignedBy) return a;
        if (!nameCache.has(a.assignedBy)) {
          try {
            const p = await storage.getProfile(a.assignedBy);
            nameCache.set(a.assignedBy, p?.name || null);
          } catch {
            nameCache.set(a.assignedBy, null);
          }
        }
        return { ...a, assignedByName: nameCache.get(a.assignedBy) || undefined };
      }),
    );

    res.json({ assignments: hydrated });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Previous Year Papers / Mocks (public read, admin write) ---
// Listing strips the questions array so the catalogue stays light. The
// detail endpoint returns the full payload, but enforces the free-tier
// limit (first 5 PYPs free, rest paywalled) for non-subscribed users.
app.get("/api/pyp", async (_req, res) => {
  try {
    const pyps = (await storage.getPyps?.()) || [];
    res.json({ pyps });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/pyp/:id", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  try {
    const all = (await storage.getPyps?.()) || [];
    const list = [...all].sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return ta - tb; // oldest first so "first 5" is stable
    });
    const idx = list.findIndex((p) => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "PYP not found" });

    // Paywall: students get the first 5 PYPs free, after that they need an
    // active subscription. Profile.subscription = { active: bool, ... }.
    const profile = await storage.getProfile(user.id.toString());
    const subscribed = profile?.subscription?.active === true;
    if (idx >= 5 && !subscribed) {
      return res.status(402).json({
        error: "Subscription required",
        code: "PAYWALL",
        freeQuota: 5,
        message: "First 5 papers / mocks are free. Subscribe to unlock the rest.",
      });
    }

    const pyp = await storage.getPyp(req.params.id);
    if (!pyp) return res.status(404).json({ error: "PYP not found" });
    res.json({ pyp });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Razorpay subscription payments ---
// Three small endpoints implement the standard Razorpay Standard Checkout
// dance. We do NOT use the razorpay npm SDK — a) avoid adding a dep, b)
// the REST API is two HTTP calls and signature verification is one HMAC.
//   1. /api/payments/config        → public, returns the publishable key + plan amount
//   2. /api/payments/create-order  → auth, creates an order at Razorpay, returns order_id
//   3. /api/payments/verify        → auth, verifies signature, flips profile.subscription
//
// We pull the actual key / amount from env so the values stay out of git.
const RZP_KEY_ID = process.env.RAZORPAY_KEY_ID || "";
const RZP_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const RZP_CURRENCY = process.env.RAZORPAY_PLAN_CURRENCY || "INR";
const RZP_DEFAULT_AMOUNT = parseInt(process.env.RAZORPAY_PLAN_AMOUNT_PAISE || "4900", 10);
const RZP_DEFAULT_VALIDITY_DAYS = parseInt(process.env.RAZORPAY_PLAN_VALIDITY_DAYS || "365", 10);

const RZP_PLANS = {
  "7d-19": { amount: 1900, validityDays: 7, label: "7 days", description: "7-day full access" },
  "30d-59": { amount: 5900, validityDays: 30, label: "1 month", description: "30-day full access" },
  "3m-149": { amount: 14900, validityDays: 90, label: "3 months", description: "3-month full access" },
  "lifetime-499": { amount: 49900, validityDays: null, label: "Lifetime", description: "Unlimited lifetime access" },
  // Legacy plan ids kept so older orders/links still resolve.
  "7d-29": { amount: 2900, validityDays: 7, label: "7 days", description: "7-day access" },
  "30d-99": { amount: 9900, validityDays: 30, label: "1 month", description: "30-day access" },
  "3m-249": { amount: 24900, validityDays: 90, label: "3 months", description: "3-month access" },
  "lifetime-999": { amount: 99900, validityDays: null, label: "Lifetime", description: "Unlimited access" },
  "yearly-49": { amount: RZP_DEFAULT_AMOUNT, validityDays: RZP_DEFAULT_VALIDITY_DAYS, label: "1 year", description: "Yearly subscription" },
};

const RZP_DEFAULT_PLAN = "30d-59";

// Plans surfaced to the client (in display order). Legacy ids above are
// intentionally excluded so the pricing page only shows current offers.
const RZP_VISIBLE_PLAN_IDS = ["7d-19", "30d-59", "3m-149", "lifetime-499"];

function razorpayConfigured() {
  return !!(RZP_KEY_ID && RZP_KEY_SECRET);
}

function getPlan(planId = RZP_DEFAULT_PLAN) {
  return RZP_PLANS[planId] || RZP_PLANS[RZP_DEFAULT_PLAN];
}

app.get("/api/payments/config", (_req, res) => {
  const subtitles = {
    "7d-19": "Trial week",
    "30d-59": "Most popular",
    "3m-149": "Best value",
    "lifetime-499": "Pay once, forever",
  };
  res.json({
    configured: razorpayConfigured(),
    keyId: RZP_KEY_ID || null,
    amount: getPlan().amount,
    currency: RZP_CURRENCY,
    plan: RZP_DEFAULT_PLAN,
    plans: RZP_VISIBLE_PLAN_IDS.map((id) => {
      const plan = RZP_PLANS[id];
      return {
        id,
        amount: plan.amount,
        currency: RZP_CURRENCY,
        label: plan.label,
        description: plan.description,
        subtitle: subtitles[id] || plan.description,
        validityDays: plan.validityDays,
        popular: id === RZP_DEFAULT_PLAN,
      };
    }),
  });
});

app.post("/api/payments/create-order", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  if (!razorpayConfigured()) {
    return res.status(503).json({ error: "Razorpay is not configured on the server." });
  }

  try {
    const planId = String(req.body?.plan || RZP_DEFAULT_PLAN);
    const plan = getPlan(planId);
    const auth = "Basic " + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
    // Razorpay receipt must be <= 40 chars. user.id may be long; truncate.
    const receipt = `s_${String(user.id).slice(0, 20)}_${Date.now().toString(36)}`;
    const r = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        amount: plan.amount,
        currency: RZP_CURRENCY,
        receipt,
        notes: { userId: String(user.id), plan: planId },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("[razorpay] create-order failed:", data);
      return res.status(502).json({ error: data?.error?.description || "Failed to create order" });
    }
    res.json({
      orderId: data.id,
      amount: data.amount,
      currency: data.currency,
      keyId: RZP_KEY_ID,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/payments/verify", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;
  if (!razorpayConfigured()) {
    return res.status(503).json({ error: "Razorpay is not configured on the server." });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan: requestedPlan } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing payment fields" });
  }

  // Signature = HMAC-SHA256(order_id + "|" + payment_id, key_secret)
  const expected = crypto
    .createHmac("sha256", RZP_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");
  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: "Signature mismatch — payment not verified" });
  }

  let planId = String(requestedPlan || "");
  if (!planId) {
    try {
      const auth = "Basic " + Buffer.from(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`).toString("base64");
      const orderRes = await fetch(
        `https://api.razorpay.com/v1/orders/${encodeURIComponent(razorpay_order_id)}`,
        { headers: { Authorization: auth } },
      );
      const orderData = await orderRes.json();
      if (orderRes.ok && orderData?.notes?.plan) {
        planId = String(orderData.notes.plan);
      }
    } catch (err) {
      console.warn("[razorpay] failed to fetch order details for plan note", err);
    }
  }

  const plan = getPlan(planId || RZP_DEFAULT_PLAN);
  const validUntil = plan.validityDays == null
    ? undefined
    : new Date(Date.now() + plan.validityDays * 86400 * 1000).toISOString();

  try {
    const profile = (await storage.getProfile(user.id.toString())) || {};
    const updated = {
      ...profile,
      subscription: {
        active: true,
        plan: planId || RZP_DEFAULT_PLAN,
        validUntil,
        razorpayPaymentId: razorpay_payment_id,
      },
    };
    await storage.saveProfile(user.id.toString(), updated);

    // Record the payment in the ledger so the admin panel can show subscription
    // history + revenue without re-querying Razorpay. Best-effort — never block
    // the payment-verify response on a ledger write.
    try {
      const purchaseAmountInr = (Number(plan.amount) || 0) / 100;
      await storage.addPayment?.({
        userId: user.id.toString(),
        email: profile?.email || user.email || null,
        name: profile?.name || user.name || null,
        role: profile?.role || user.role || "student",
        plan: planId || RZP_DEFAULT_PLAN,
        planLabel: plan.label || null,
        amount: purchaseAmountInr,
        amountPaise: Number(plan.amount) || 0,
        currency: RZP_CURRENCY,
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        status: "captured",
        validUntil: validUntil || null,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn("[payments] ledger write failed:", err?.message || err);
    }

    // Referral commission: if this buyer was referred by a teacher, create a
    // PENDING commission (10%). Best-effort — never block the payment response.
    try {
      const purchaseAmountInr = (Number(plan.amount) || 0) / 100; // paise -> INR
      await createCommissionForOrder(storage, {
        buyerId: user.id.toString(),
        orderId: razorpay_order_id,
        purchaseAmount: purchaseAmountInr,
      });
    } catch (err) {
      console.warn("[referral] commission creation failed:", err?.message || err);
    }

    res.json({ ok: true, subscription: updated.subscription });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- AI Chat (Groq-powered Q&A) ---
const groqApiKey = process.env.GROQ_API_KEY_CHAT || process.env.GROQ_API_KEY;
const groqClient = groqApiKey
  ? new Groq({
      apiKey: groqApiKey,
    })
  : null;

app.post("/api/ai/chat", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;

  if (!groqClient) {
    return res.status(503).json({ error: "AI service is not configured. Please set GROQ_API_KEY_CHAT or GROQ_API_KEY in environment." });
  }

  try {
    const { message, conversationHistory } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const systemPrompt = `You are "Guru" — a friendly, energetic and deeply knowledgeable tutor for students preparing for NEET, JEE, BITSAT, CBSE, HBSE and Board exams. You teach Physics, Chemistry, Biology and Mathematics.

TEACHING STYLE (very important):
- Teach like an amazing human teacher, NOT like a dry textbook. Be warm, encouraging and engaging.
- Explain concepts DEEPLY but in simple language. Start from the basics and build up.
- Use real-life analogies and everyday examples so the student actually "gets it".
- Break things into clear steps. Use a logical flow: what it is → why it matters → how it works → example → exam tips.
- Add a touch of fun with relevant emoji (🌱⚛️🔬🧪📐💡), but don't overdo it.

ALWAYS FORMAT YOUR ANSWER IN RICH MARKDOWN:
- Use "##" headings to organise sections (e.g. "## What is it?", "## How it works", "## Example", "## 📝 Quick Recap").
- Use **bold** for key terms and important points.
- Use bullet points and numbered lists for steps.
- Use markdown tables when comparing things.
- For any math/formula use clear notation (e.g. \`E = mc²\`, fractions written clearly).
- End every explanation with a "## 📝 Quick Recap" section (3-5 short bullet points) and a "## 🎯 Exam Tip" line.

DEPTH:
- Give a genuinely detailed, classroom-quality explanation. Don't be lazy or overly short.
- If the topic is broad, cover the most exam-relevant parts thoroughly.

Be supportive and motivating. Make the student feel like learning is enjoyable.`;

    const messages = [
      ...(conversationHistory || []).map((msg) => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content,
      })),
      {
        role: "user",
        content: message,
      },
    ];

    const response = await groqClient.chat.completions.create({
      model: process.env.GROQ_MODEL_CHAT || "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        ...messages,
      ],
      max_tokens: 2000,
      temperature: 0.7,
    });

    const assistantMessage = response.choices[0]?.message?.content || "Sorry, I couldn't generate a response.";

    res.json({ response: assistantMessage });
  } catch (e) {
    console.error("[ai/chat] Groq API error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- Free educational images from Wikipedia (no API key needed) ---
// Given a topic/query, returns real diagram/illustration images from Wikipedia.
app.post("/api/ai/images", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;

  try {
    const query = String((req.body || {}).query || "").trim();
    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }

    // Use MediaWiki API: search top pages and pull their thumbnail images.
    const url =
      "https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*" +
      "&prop=pageimages|pageterms&generator=search&redirects=1" +
      `&gsrsearch=${encodeURIComponent(query)}&gsrlimit=4` +
      "&piprop=thumbnail&pithumbsize=640&pilimit=4";

    const wikiResp = await fetch(url, {
      headers: { "User-Agent": "ExamPrepHub/1.0 (educational tutor app)" },
    });

    if (!wikiResp.ok) {
      return res.json({ images: [] });
    }

    const data = await wikiResp.json();
    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];

    const images = pages
      .filter((p) => p?.thumbnail?.source)
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((p) => ({
        title: p.title,
        url: p.thumbnail.source,
        description: p?.terms?.description?.[0] || "",
        source: `https://en.wikipedia.org/wiki/${encodeURIComponent((p.title || "").replace(/ /g, "_"))}`,
      }));

    res.json({ images });
  } catch (e) {
    console.error("[ai/images] Wikipedia fetch error:", e);
    res.json({ images: [] });
  }
});

app.post("/api/ai/dpp-chat", requireAuth, async (req, res) => {
  const user = getCurrentUser(req, res);
  if (!user) return;

  try {
    const { message, conversationHistory, subject, chapter } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required" });
    }

    const systemPrompt = `You are a real-time Gemini tutor for DPP practice.
Help the student solve the current chapter question, show the reasoning, and keep the answer practical.
If the user asks for only the final answer, provide it succinctly.
If they ask for a hint, give a small hint first.
Subject context: ${subject || "Unknown"}
Chapter context: ${chapter || "Unknown"}`;

    const response = await answerWithGemini({
      message,
      conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
      modelName: process.env.GEMINI_DPP_CHAT_MODEL || process.env.GEMINI_DPP_MODEL || process.env.GEMINI_MODEL || "gemini-3-flash-preview",
      systemInstruction: systemPrompt,
    });

    res.json({ response });
  } catch (e) {
    console.error("[ai/dpp-chat] Gemini API error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

function startServer(port, attempt = 0) {
  const MAX_ATTEMPTS = 10;
  const server = app.listen(port, () => {
    // Show the actual storage adapter in use (may differ from STORAGE env if fallback occurred)
    const storageName = storage === supabaseStorage ? "supabase" : "json";
    console.log(`[gurutron-server] listening on http://localhost:${port} (storage=${storageName})`);
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE" && attempt < MAX_ATTEMPTS) {
      const next = port + 1;
      console.warn(`[gurutron-server] port ${port} in use, trying ${next} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      // Try next port after a short delay to avoid rapid recursion
      setTimeout(() => startServer(next, attempt + 1), 150);
    } else {
      console.error("[gurutron-server] server error:", err);
      process.exit(1);
    }
  });
}

startServer(PORT);
