import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import session from "express-session";
import crypto from "crypto";
import multer from "multer";
import path from "path";
import Groq from "groq-sdk";
import authRoutes from "./routes/auth.js";
import { jsonStorage } from "./storage/json.js";
import { supabaseStorage } from "./storage/supabase.js";
import { buildAdminRouter } from "./admin-routes.js";
import { getPageImageBytes } from "./storage/pdf-storage.js";
import { saveCaptureImage, CAPTURES_LOCAL_DIR } from "./storage/capture-storage.js";
import { hashPassword } from "./password.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const storage = process.env.STORAGE === "supabase" ? supabaseStorage : jsonStorage;

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
    // Allow same-origin / curl (no origin header) and any explicitly whitelisted origin.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    // Reject CORS properly (don't throw error which becomes 500)
    cb(null, false);
  },
  credentials: true,
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
  res.json({ ok: true, storage: process.env.STORAGE || "json" });
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
    const buf = await getPageImageBytes({ docId, pageNumber, backend });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (e) {
    res.status(404).json({ error: String(e.message || e) });
  }
});

// Admin routes (login, stats, questions CRUD, PDF parse)
app.use("/api/admin", buildAdminRouter(storage));

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
    const teacherInviteCode = incoming.teacherInviteCode;
    const rawPassword = incoming.password;
    // Never persist the invite code or the raw password in the profile.
    delete incoming.teacherInviteCode;
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

    // Invite-only check: a user can only become a teacher if they provide
    // the configured invite code (or are already a teacher in storage).
    if (incoming.role === "teacher") {
      const alreadyTeacher = existing && existing.role === "teacher";
      if (!alreadyTeacher) {
        const expected = (process.env.TEACHER_INVITE_CODE || "").trim();
        if (!expected) {
          return res.status(503).json({
            error: "Teacher registration is disabled. Ask the admin to set TEACHER_INVITE_CODE.",
          });
        }
        if (!teacherInviteCode || teacherInviteCode.trim() !== expected) {
          return res.status(403).json({
            error: "Invalid teacher invite code. Please contact your admin.",
          });
        }
      }
    }

    const merged = {
      ...existing,
      ...incoming,
      // Always retain identity / auth fields from the existing profile unless
      // the client is explicitly setting a new password (already hashed above).
      email: incoming.email || existing.email,
      passwordHash: incoming.passwordHash || existing.passwordHash,
    };

    const saved = await storage.saveProfile(user.id.toString(), merged);
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

// Teacher: approve/reject a membership
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
  "7d-29": { amount: 2900, validityDays: 7, label: "7 days", description: "7-day access" },
  "30d-99": { amount: 9900, validityDays: 30, label: "30 days", description: "30-day access" },
  "3m-249": { amount: 24900, validityDays: 90, label: "3 months", description: "3-month access" },
  "lifetime-999": { amount: 99900, validityDays: null, label: "Lifetime", description: "Unlimited access" },
  "yearly-49": { amount: RZP_DEFAULT_AMOUNT, validityDays: RZP_DEFAULT_VALIDITY_DAYS, label: "1 year", description: "Yearly subscription" },
};

const RZP_DEFAULT_PLAN = "30d-99";

function razorpayConfigured() {
  return !!(RZP_KEY_ID && RZP_KEY_SECRET);
}

function getPlan(planId = RZP_DEFAULT_PLAN) {
  return RZP_PLANS[planId] || RZP_PLANS[RZP_DEFAULT_PLAN];
}

app.get("/api/payments/config", (_req, res) => {
  res.json({
    configured: razorpayConfigured(),
    keyId: RZP_KEY_ID || null,
    amount: getPlan().amount,
    currency: RZP_CURRENCY,
    plan: RZP_DEFAULT_PLAN,
    plans: Object.entries(RZP_PLANS).map(([id, plan]) => ({
      id,
      amount: plan.amount,
      currency: RZP_CURRENCY,
      label: plan.label,
      description: plan.description,
      validityDays: plan.validityDays,
    })),
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

    const systemPrompt = `You are a helpful AI study assistant for students preparing for competitive exams like NEET and JEE. 
Your role is to:
- Explain complex concepts clearly and concisely
- Answer questions about NEET, JEE, Board, CBSE, and HBSE exam topics
- Help with physics, chemistry, biology, and mathematics
- Provide study tips and exam strategies
- Be encouraging and supportive

Keep responses concise (1-2 paragraphs) unless asked for more detail.`;

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
      max_tokens: 500,
      temperature: 0.7,
    });

    const assistantMessage = response.choices[0]?.message?.content || "Sorry, I couldn't generate a response.";

    res.json({ response: assistantMessage });
  } catch (e) {
    console.error("[ai/chat] Groq API error:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[gurutron-server] listening on http://localhost:${PORT} (storage=${process.env.STORAGE || "json"})`);
});
