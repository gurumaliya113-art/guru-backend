import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import session from "express-session";
import authRoutes from "./routes/auth.js";
import { jsonStorage } from "./storage/json.js";
import { supabaseStorage } from "./storage/supabase.js";
import { buildAdminRouter } from "./admin-routes.js";
import { getPageImageBytes } from "./storage/pdf-storage.js";

const PORT = parseInt(process.env.PORT || "4000", 10);
const storage = process.env.STORAGE === "supabase" ? supabaseStorage : jsonStorage;

const app = express();
// CORS: allow comma-separated origins via FRONTEND_URL or CLIENT_ORIGIN.
// Example: FRONTEND_URL="https://frontend-two.vercel.app,http://localhost:5173"
const allowedOrigins = (process.env.FRONTEND_URL || process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin / curl (no origin header) and any explicitly whitelisted origin.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
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
    const incoming = { ...(req.body || {}) };
    const teacherInviteCode = incoming.teacherInviteCode;
    // Never persist the invite code in the profile.
    delete incoming.teacherInviteCode;

    // Invite-only check: a user can only become a teacher if they provide
    // the configured invite code (or are already a teacher in storage).
    if (incoming.role === "teacher") {
      const existing = await storage.getProfile(user.id.toString());
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

    const saved = await storage.saveProfile(user.id.toString(), incoming);
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
    res.json({ assignments: mine });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`[gurutron-server] listening on http://localhost:${PORT} (storage=${process.env.STORAGE || "json"})`);
});
