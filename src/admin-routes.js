// Admin routes — mounted at /api/admin/* by server/src/index.js.
import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import { adminLogin, adminLogout, requireAdmin } from "./auth.js";
import { parseHeuristic } from "./parsers/heuristic.js";
import { parseWithGemini, parseWithGeminiVision, isGeminiAvailable, getGeminiKeyLabel } from "./parsers/gemini.js";
import { parseWithGroq, isGroqAvailable } from "./parsers/groq.js";
import { extractPdfPages } from "./parsers/pdf-extract.js";
import { extractRawPdfPages } from "./parsers/pdf-raw.js";
import { extractDocxPages } from "./parsers/docx-extract.js";
import { renderPagesToPng } from "./parsers/pdf-render.js";
import { applySolutionSheet } from "./parsers/solution-match.js";
import {
  saveDocumentBytes,
  getPdfBytes,
  savePageImage,
  saveFigureImage,
  newDocumentId,
} from "./storage/pdf-storage.js";
import { summarizeCommissions, cancelCommissionForOrder } from "./referral.js";
import { subscribe, createJob, startPage, completePage, completeJob, stopJob, failJob, isTerminal } from "./progress-service.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const upload = multer({
  storage: multer.memoryStorage(), // we never persist the PDF — only its extracted text
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    if (
      file.mimetype === "application/pdf" ||
      lower.endsWith(".pdf") ||
      file.mimetype === "image/png" ||
      file.mimetype === "image/jpeg" ||
      lower.endsWith(".png") ||
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      lower.endsWith(".docx") ||
      file.mimetype === "application/msword" ||
      lower.endsWith(".doc")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, image, and Word documents (.doc, .docx) are supported"));
    }
  },
});

// ---- Tuning knobs for the heavy "AI Pro Max" (dpp / vision) path ----
// These keep a single /parse-pdf request within the hosting platform's request
// timeout and memory budget so it returns a real result instead of a 502
// (gateway timeout / OOM crash of the container).
//
// PDF_RENDER_SCALE: render resolution. Pixmap memory grows with scale², so
//   1.35 uses ~44% less RAM than 1.8 while staying legible for AI vision.
// GEMINI_CALL_TIMEOUT_MS: max time to wait on a single Gemini call before we
//   give up and fall back to a fast parser.
// MAX_FIGURE_PAGES: cap on how many figure snapshots we render per upload.
const PDF_RENDER_SCALE = Number(process.env.PDF_RENDER_SCALE || 1.35);
// Per-call budget. Kept SHORT so one slow Gemini call can't drag the whole
// request past the hosting gateway's timeout (which surfaces to the client as
// a 502). A stuck page is abandoned and we move on / fall back.
const GEMINI_CALL_TIMEOUT_MS = Number(process.env.GEMINI_CALL_TIMEOUT_MS || 30000);
const MAX_FIGURE_PAGES = Number(process.env.MAX_FIGURE_PAGES || 3);
// If the parse has already spent this long by the time we reach the (optional)
// figure-snapshot rendering step, SKIP it. Questions keep their pageNumber, so
// the admin can still open+crop that page on demand later — we just don't block
// the HTTP response (and risk a gateway 502) rendering images inline.
const FIGURE_RENDER_BUDGET_MS = Number(process.env.FIGURE_RENDER_BUDGET_MS || 18000);
// Scanned / image-only PDFs are read page-by-page with Gemini vision. We render
// at a higher scale than figure snapshots so the model can actually read the
// text, and we process more pages (questions are often NOT on the first 1-2
// cover/instruction pages).
const VISION_RENDER_SCALE = Number(process.env.PDF_VISION_SCALE || 1.4);
const VISION_PAGE_CAP = Number(process.env.DPP_VISION_PAGE_CAP || 8);
// Overall wall-clock budget for the whole vision pass. Once exceeded we STOP
// requesting more pages and return whatever questions we already have — a
// partial-but-real result with HTTP 200 instead of a gateway 502. Sized to sit
// safely under typical platform request timeouts.
const PARSE_TIME_BUDGET_MS = Number(process.env.PARSE_TIME_BUDGET_MS || 45000);

/**
 * Crop a normalized [x0,y0,x1,y1] region out of a full-page PNG buffer and
 * return a PNG buffer of just that region (with a little padding). Used to
 * pull individual diagrams out of a rendered scanned page.
 */
async function cropRegionToPng(pngBuffer, box, pad = 0.02) {
  try {
    const img = await loadImage(pngBuffer);
    const W = img.width;
    const H = img.height;
    let [x0, y0, x1, y1] = box;
    // add padding
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(1, x1 + pad);
    y1 = Math.min(1, y1 + pad);
    const sx = Math.floor(x0 * W);
    const sy = Math.floor(y0 * H);
    const sw = Math.max(1, Math.ceil((x1 - x0) * W));
    const sh = Math.max(1, Math.ceil((y1 - y0) * H));
    const canvas = createCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toBuffer("image/png");
  } catch (e) {
    console.warn("[parse-pdf] figure crop failed:", e.message);
    return null;
  }
}

/** Reject with a clear error if `promise` doesn't settle within `ms`. */
function withTimeout(promise, ms, label = "operation") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB for images
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    if (
      file.mimetype === "image/png" ||
      lower.endsWith(".png") ||
      file.mimetype === "image/jpeg" ||
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PNG and JPEG images are supported for cropping"));
    }
  },
});

function getFileType(filename) {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".doc")) return "doc";
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image";
  return "unknown";
}

function getMimeType(filename, mimetype) {
  if (mimetype) return mimetype;
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

// Clean common PDF-extraction artifacts in a string:
//   "√--x" / "√ — x" -> "√x"  (a square root's overline/vinculum bar is often
//   extracted as one or more dashes between the √ and its radicand).
function cleanExtractedText(s) {
  if (typeof s !== "string") return s;
  return s.replace(/√\s*[-–—−]{1,}\s*/g, "√");
}

// Apply text cleanup to a question's user-facing fields.
function cleanQuestionArtifacts(q) {
  if (!q || typeof q !== "object") return q;
  return {
    ...q,
    text: cleanExtractedText(q.text),
    options: Array.isArray(q.options) ? q.options.map(cleanExtractedText) : q.options,
    explanation: cleanExtractedText(q.explanation),
  };
}

export function buildAdminRouter(storage) {
  const r = Router();

  // ---- Auth ----
  r.post("/login", (req, res) => {
    const { email, password } = req.body || {};
    const token = adminLogin(email, password);
    if (!token) return res.status(401).json({ error: "Invalid credentials" });
    res.json({ token });
  });

  r.post("/logout", (req, res) => {
    adminLogout(req.header("x-admin-token"));
    res.json({ ok: true });
  });

  r.get("/me", requireAdmin, (_req, res) => {
    res.json({
      ok: true,
      geminiAvailable: isGeminiAvailable(),
      groqAvailable: isGroqAvailable(),
    });
  });

  // ---- Documents (uploaded PDFs metadata) ----
  r.get("/documents", requireAdmin, async (_req, res) => {
    try {
      const documents = (await storage.getDocuments?.()) || [];
      res.json({ documents });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- Stats ----
  r.get("/stats", requireAdmin, async (_req, res) => {
    try {
      const questions = await storage.getQuestions();
      const bySubject = {}, byExam = {}, byDifficulty = {}, bySource = {};
      for (const q of questions) {
        bySubject[q.subject] = (bySubject[q.subject] || 0) + 1;
        byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] || 0) + 1;
        bySource[q.source || "manual"] = (bySource[q.source || "manual"] || 0) + 1;
        for (const e of (q.examType || [])) byExam[e] = (byExam[e] || 0) + 1;
      }
      res.json({
        total: questions.length,
        bySubject, byExam, byDifficulty, bySource,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- Questions CRUD ----
  r.get("/questions", requireAdmin, async (_req, res) => {
    try {
      const questions = await storage.getQuestions();
      res.json({ questions });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.post("/questions", requireAdmin, async (req, res) => {
    try {
      const incoming = Array.isArray(req.body?.questions)
        ? req.body.questions
        : req.body
          ? [req.body]
          : [];
      const normalised = incoming.map((q) => ({
        id: q.id || "q_" + crypto.randomBytes(4).toString("hex"),
        subject: q.subject || "Physics",
        topic: q.topic || "",
        text: q.text || "",
        options: Array.isArray(q.options) ? q.options.slice(0, 4) : ["", "", "", ""],
        correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
        explanation: q.explanation || "",
        difficulty: q.difficulty || "Moderate",
        type: q.type || "MCQ",
        examType: Array.isArray(q.examType) && q.examType.length ? q.examType : ["NEET"],
        year: q.year ?? undefined,
        classLevel: q.classLevel || undefined,
        board: q.board || undefined,
        isNCERT: typeof q.isNCERT === "boolean" ? q.isNCERT : false,
        source: q.source || "manual",
        documentId: q.documentId || undefined,
        pageNumber: Number.isInteger(q.pageNumber) && q.pageNumber > 0 ? q.pageNumber : undefined,
        hasFigure: typeof q.hasFigure === "boolean" ? q.hasFigure : false,
        pageImageUrl: q.pageImageUrl || undefined,
        createdAt: q.createdAt || new Date().toISOString(),
      }));
      const added = await storage.addQuestions(normalised);
      res.json({ added: added.length, questions: added });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  r.put("/questions/:id", requireAdmin, async (req, res) => {
    try {
      const updated = await storage.updateQuestion(req.params.id, req.body || {});
      if (!updated) return res.status(404).json({ error: "Question not found" });
      res.json({ question: updated });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- Topics catalogue ----
  // Admin-managed list of topics that surfaces in the teacher's Paper
  // Generation flow. Storing topics independently of questions lets admins
  // pre-seed a syllabus before any questions exist for it.
  r.get("/topics", requireAdmin, async (_req, res) => {
    try {
      const topics = await storage.getTopics();
      res.json({ topics });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.post("/topics", requireAdmin, async (req, res) => {
    try {
      const { subject, name, classLevel, examType } = req.body || {};
      if (!subject || !String(subject).trim()) {
        return res.status(400).json({ error: "subject is required" });
      }
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: "name is required" });
      }
      const topic = {
        id: `t_${crypto.randomBytes(6).toString("hex")}`,
        subject: String(subject).trim(),
        name: String(name).trim(),
        classLevel: classLevel ? String(classLevel).trim() : null,
        examType: examType ? String(examType).trim() : null,
        createdAt: new Date().toISOString(),
      };
      const saved = await storage.addTopic(topic);
      res.json({ topic: saved });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.delete("/topics/:id", requireAdmin, async (req, res) => {
    try {
      await storage.deleteTopic(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- Flashcards deck management ----
  r.get("/flashcards", requireAdmin, async (_req, res) => {
    try {
      const flashcards = await storage.getFlashcards?.() || [];
      res.json({ flashcards });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.post("/flashcards", requireAdmin, async (req, res) => {
    try {
      const { subject, topic, classLevel, examType, question, answer, difficulty } = req.body || {};
      if (!subject || !String(subject).trim()) return res.status(400).json({ error: "subject is required" });
      if (!topic || !String(topic).trim()) return res.status(400).json({ error: "topic is required" });
      if (!question || !String(question).trim()) return res.status(400).json({ error: "question is required" });
      if (!answer || !String(answer).trim()) return res.status(400).json({ error: "answer is required" });
      const card = {
        id: `fc_${crypto.randomBytes(6).toString("hex")}`,
        subject: String(subject).trim(),
        topic: String(topic).trim(),
        classLevel: classLevel ? String(classLevel).trim() : null,
        examType: examType ? String(examType).trim() : null,
        question: String(question).trim(),
        answer: String(answer).trim(),
        difficulty: difficulty ? String(difficulty).trim() : "Moderate",
        createdAt: new Date().toISOString(),
      };
      const saved = await storage.addFlashcard(card);
      res.json({ flashcard: saved });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.delete("/flashcards/:id", requireAdmin, async (req, res) => {
    try {
      await storage.deleteFlashcard?.(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- Notes management (admin upload) ----
  r.get("/notes", requireAdmin, async (_req, res) => {
    try {
      const notes = await storage.getNotes?.() || [];
      res.json({ notes });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.post("/notes", requireAdmin, async (req, res) => {
    try {
      const { title, subject, chapter, examType, classLevel, board, description, fileUrl } = req.body || {};
      if (!title || !String(title).trim()) return res.status(400).json({ error: "title is required" });
      if (!subject || !String(subject).trim()) return res.status(400).json({ error: "subject is required" });
      
      const note = {
        id: `note_${crypto.randomBytes(6).toString("hex")}`,
        title: String(title).trim(),
        subject: String(subject).trim(),
        chapter: chapter ? String(chapter).trim() : null,
        examType: examType ? String(examType).trim() : null,
        classLevel: classLevel ? String(classLevel).trim() : null,
        board: board ? String(board).trim() : null,
        description: description ? String(description).trim() : "",
        fileUrl: fileUrl ? String(fileUrl).trim() : null,
        uploadedBy: req.session?.user?.id || "admin",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      
      const saved = await storage.addNote(note);
      res.json({ note: saved });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.put("/notes/:id", requireAdmin, async (req, res) => {
    try {
      const { title, subject, chapter, examType, classLevel, board, description, fileUrl } = req.body || {};
      const updates = {};
      if (title !== undefined) updates.title = String(title).trim();
      if (subject !== undefined) updates.subject = String(subject).trim();
      if (chapter !== undefined) updates.chapter = chapter ? String(chapter).trim() : null;
      if (examType !== undefined) updates.examType = examType ? String(examType).trim() : null;
      if (classLevel !== undefined) updates.classLevel = classLevel ? String(classLevel).trim() : null;
      if (board !== undefined) updates.board = board ? String(board).trim() : null;
      if (description !== undefined) updates.description = description ? String(description).trim() : "";
      if (fileUrl !== undefined) updates.fileUrl = fileUrl ? String(fileUrl).trim() : null;
      updates.updatedAt = new Date().toISOString();
      
      const updated = await storage.updateNote(req.params.id, updates);
      if (!updated) return res.status(404).json({ error: "Note not found" });
      res.json({ note: updated });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.delete("/notes/:id", requireAdmin, async (req, res) => {
    try {
      await storage.deleteNote?.(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // ---- Previous Year Papers / Mocks (admin upload) ----
  // Admin creates a PYP by sending the full questions array. We don't try
  // to parse PDFs here — the regular /parse-pdf flow already extracts
  // questions; the admin can review them and then POST the resulting
  // array into this endpoint to wrap them up as a "previous year paper".
  r.get("/pyp", requireAdmin, async (_req, res) => {
    try {
      const pyps = await storage.getPyps();
      res.json({ pyps });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.post("/pyp", requireAdmin, async (req, res) => {
    try {
      const { title, examType, year, subject, durationMinutes, questions } = req.body || {};
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: "title is required" });
      }
      if (!examType || !["NEET", "JEE", "BOARD"].includes(String(examType).toUpperCase())) {
        return res.status(400).json({ error: "examType must be NEET / JEE / BOARD" });
      }
      const y = Number(year);
      if (!Number.isInteger(y) || y < 1990 || y > 2100) {
        return res.status(400).json({ error: "year must be a valid 4-digit year" });
      }
      if (!Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: "questions[] must be a non-empty array" });
      }

      const pyp = {
        id: `pyp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title: String(title).trim(),
        examType: String(examType).toUpperCase(),
        year: y,
        subject: subject ? String(subject).trim() : undefined,
        durationMinutes:
          durationMinutes != null && Number.isFinite(Number(durationMinutes))
            ? Number(durationMinutes)
            : undefined,
        questions,
        createdAt: new Date().toISOString(),
      };
      await storage.addPyp(pyp);
      res.json({ pyp });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.delete("/pyp/:id", requireAdmin, async (req, res) => {
    try {
      await storage.deletePyp(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  r.delete("/questions/:id", requireAdmin, async (req, res) => {
    try {
      await storage.deleteQuestion(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- Realtime parse progress (SSE) ----
  // GET /api/admin/parse-pdf/progress/:jobId
  //   Server-Sent Events stream of live page-level progress for a parse job.
  //   Guarded by requireAdmin, which accepts either the admin session or
  //   ?token=<adminToken> — EventSource cannot set the x-admin-token header, so
  //   the frontend passes the same token in the query string.
  //
  //   The stream is a read-only observer of the Progress_Service. It NEVER
  //   controls the running parse: closing the connection only unsubscribes; the
  //   POST /parse-pdf request keeps running to completion regardless.
  r.get("/parse-pdf/progress/:jobId", requireAdmin, (req, res) => {
    const { jobId } = req.params;

    // SSE headers — set before any body is written so the client opens the
    // stream immediately. X-Accel-Buffering: no disables proxy buffering (e.g.
    // nginx) so each event flushes right away instead of being batched.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    // Disable Nagle so small event writes are sent without delay, and open the
    // stream with an initial comment so the client sees bytes immediately.
    try {
      res.socket?.setNoDelay?.(true);
    } catch {
      // Non-socket transports (e.g. test doubles) simply skip this.
    }
    res.write(": connected\n\n");

    // Guard every write against a closed stream so a late event (or heartbeat)
    // after res.end() can never throw. `ended` also prevents a double res.end()
    // when the terminal event arrives during the synchronous subscribe replay.
    let closed = false;
    let ended = false;
    let unsubscribe = () => {};

    const finish = () => {
      if (ended) return;
      ended = true;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // Already closed by the client — nothing to do.
      }
    };

    // Write one Progress_Event in SSE wire format:
    //   event: <type>\n
    //   data: <json>\n\n
    // On a terminal event, close the stream after writing it.
    const onEvent = (event) => {
      if (closed) return;
      try {
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Write failed (client vanished) — treat as closed.
        finish();
        return;
      }
      if (
        event.type === "complete" ||
        event.type === "stopped" ||
        event.type === "failure"
      ) {
        finish();
      }
    };

    // Heartbeat comment keeps intermediaries from closing an idle connection
    // during long gaps between pages. Cleared on close / terminal via finish().
    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        finish();
      }
    }, 15000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    // Subscribe replays buffered events synchronously (total + any completed
    // pages), then streams live events. If the job is ALREADY terminal, the
    // replay delivers the terminal event and onEvent -> finish() ends the stream
    // right here; the `ended` flag makes that safe against a double end.
    unsubscribe = subscribe(jobId, onEvent);

    // If the terminal event already fired during the synchronous replay (job was
    // already complete/stopped/failed when we subscribed), finish() has already
    // ended the stream — nothing more to wire up.
    if (ended) return;

    // Client disconnect: unsubscribe + clear heartbeat. Never touches the job.
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---- PDF upload + parse (full pipeline) ----
  // POST /api/admin/parse-pdf
  //   multipart form-data, field "file"
  //   optional: mode = "auto" (default) | "groq" | "gemini" | "heuristic"
  //   optional: save = "1" (persist PDF + document + questions)  | "0" (preview only)
  //   optional: subject, examType, classLevel, notes  (metadata for the document)
  //
  // Returns: { documentId?, parser, pageCount, textLength, isScanned, questions, saved }
  r.post("/parse-pdf", requireAdmin, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded (field: file)" });

    // jobId ties this parse to its live progress stream. The frontend generates
    // it and sends it as a multipart field (parsed by multer into req.body) so it
    // can open the SSE connection before this request returns; non-UI callers
    // fall back to a server-generated UUID. Declared before the try so the outer
    // catch can also notify subscribers if extraction throws.
    const jobId = (req.body?.jobId && String(req.body.jobId)) || crypto.randomUUID();

    const requestedMode = (req.body?.mode || req.query?.mode || "auto").toLowerCase();
    // saveQuestions: controls whether extracted questions are inserted into the bank.
    //   default = false (preview mode — admin reviews, then clicks "Save All")
    // The PDF bytes + documents row are ALWAYS persisted so the upload is tracked.
    const saveQuestions = (req.body?.save ?? req.query?.save ?? "0").toString() === "1";
    const meta = {
      subject: req.body?.subject || null,
      examType: req.body?.examType || null,
      classLevel: req.body?.classLevel || null,
      notes: req.body?.notes || null,
    };

    try {
      const fileType = getFileType(req.file.originalname);
      const documentId = newDocumentId();
      const isImageUpload = fileType === "image";
      // Wall-clock anchor for the whole request. Optional/heavy post-steps
      // (figure rendering) are skipped once we're too close to the gateway
      // timeout, so the endpoint always returns 200 instead of a 502.
      const parseStartedAt = Date.now();

      // ---- 1. Extract text or parse image input ----
      console.log(`[parse-pdf] Starting extraction for ${fileType} with mode: ${requestedMode}`);
      const extracted = fileType === "pdf"
        ? requestedMode === "raw"
          ? await extractRawPdfPages(req.file.buffer)
          : await extractPdfPages(req.file.buffer)
        : fileType === "docx"
          ? await extractDocxPages(req.file.buffer)
          : null;

      const text = extracted?.fullText?.trim() || "";
      const pageCount = extracted?.pageCount || (isImageUpload ? 1 : 0);
      const pagesHaveImages = extracted?.pages?.some((p) => p.hasImage) || isImageUpload;
      const totalChars = extracted?.pages?.reduce((s, p) => s + (p.text?.length || 0), 0) || 0;
      const isScanned = fileType === "pdf" && totalChars < 100;

      // ---- Register the progress job (Component 3: parse-pdf instrumentation).
      // Total_Pages is the PDF page count (already 1 for a single image upload).
      // This runs BEFORE any parsing/looping begins so a subscribed client sees
      // the initial `total` event first. All progress calls are additive,
      // fire-and-forget side effects — extraction behaviour is unchanged when no
      // client is connected.
      createJob(jobId, { totalPages: pageCount });

      // Unreadable / corrupt / password-protected document: extraction produced
      // no usable pages (null result for a pdf/docx, or a pdf with zero pages).
      // A scanned PDF with little text is NOT unreadable — it takes the vision
      // path — so we only fail the genuinely-unreadable case. failJob is an
      // additive signal; the HTTP response below is left unchanged.
      const unreadable =
        (fileType === "pdf" && (!extracted || pageCount === 0)) ||
        (fileType === "docx" && !extracted);
      if (unreadable) {
        failJob(jobId, {
          message: "Could not read this file — it may be corrupted or password-protected.",
        });
      }

      let questions = [];
      let parserUsed = "heuristic";
      // Vision context (populated by the AI Pro Max / vision path):
      //   visionAnswers   : questionNumber -> { correctIndex, explanation } from any answer key / solutions page
      //   visionPageBuffers: pageNumber -> rendered PNG buffer, used to crop out diagrams
      const visionAnswers = new Map();
      const visionPageBuffers = new Map();
      const mergeVisionAnswers = (answers) => {
        for (const a of answers || []) {
          if (a.number == null) continue;
          const prev = visionAnswers.get(a.number) || { correctIndex: null, explanation: "" };
          if (prev.correctIndex == null && a.correctIndex != null) prev.correctIndex = a.correctIndex;
          if (!prev.explanation && a.explanation) prev.explanation = a.explanation;
          visionAnswers.set(a.number, prev);
        }
      };

      const saveAsDocument = async (storagePath, storageBackend) => {
        const doc = {
          id: documentId,
          filename: req.file.originalname || "upload",
          storagePath,
          storageBackend,
          sizeBytes: req.file.size || req.file.buffer.length || null,
          pageCount,
          textLength: text.length,
          isScanned: Boolean(isScanned),
          parser: parserUsed,
          status: "ready",
          uploadedBy: req.session?.user?.id || null,
          subject: meta.subject,
          examType: meta.examType,
          classLevel: meta.classLevel,
          notes: meta.notes,
          createdAt: new Date().toISOString(),
        };
        try {
          await storage.addDocument?.(doc);
        } catch (e) {
          console.error("[parse-pdf] addDocument failed:", e.message);
        }
      };

      const saveQuestionsWithDocument = async (list) => {
        const linked = list.map((q) => ({
          ...q,
          id: q.id || "q_" + crypto.randomBytes(4).toString("hex"),
          documentId,
          classLevel: q.classLevel || meta.classLevel || undefined,
          createdAt: q.createdAt || new Date().toISOString(),
        }));
        await storage.addQuestions(linked);
        return linked;
      };

      // ---- 2. Decide which parser to use ----
      // dpp: Gemini 2.5 Pro vision for camera images / scanned PDFs.
      // auto: groq if available, else heuristic. Gemini only if explicitly asked.
      const tryGroq = async () => {
        questions = await parseWithGroq(text);
        parserUsed = "groq";
      };
      const tryHeuristic = () => {
        questions = parseHeuristic(text);
        parserUsed = "heuristic";
      };
      // AI Pro Max: one smart Gemini handler that reads text PDFs, scanned /
      // image-only PDFs (via page rendering + vision), and single images.
      const tryGeminiSmart = async () => {
        questions = [];
        parserUsed = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
        const fastPageCap = Number(process.env.DPP_FAST_PAGE_CAP || 2);

        if (isImageUpload) {
          try {
            const res = await withTimeout(
              parseWithGeminiVision({
                imageBuffer: req.file.buffer,
                mimeType: getMimeType(req.file.originalname, req.file.mimetype),
                modelName: parserUsed,
                pageNumber: 1,
                source: "dpp-ai",
              }),
              GEMINI_CALL_TIMEOUT_MS,
              "Gemini vision (image)"
            );
            questions = res.questions;
            mergeVisionAnswers(res.answers);
            visionPageBuffers.set(1, req.file.buffer);
            return;
          } catch (e) {
            console.warn(`[parse-pdf] Gemini vision failed, falling back to heuristic: ${e.message}`);
            questions = parseHeuristic(text);
            parserUsed = "heuristic";
            return;
          }
        }

        if (fileType === "pdf") {
          // AI Pro Max ALWAYS reads the rendered PAGE IMAGE with Gemini vision —
          // even for digital/text PDFs. Plain text extraction garbles math
          // symbols (vector hats î ĵ k̂ -> "^i", roots √x -> "√--x", powers t²
          // -> "^2^", sub/superscripts), which is the ROOT CAUSE of the messy
          // questions. Vision reads the actual visual page and returns clean
          // LaTeX, fixing all of it at the source instead of patching each
          // artifact after the fact. Set DPP_TEXT_PDF_VISION=0 to fall back to
          // the (faster but noisier) text path.
          const useVisionForTextPdf = (process.env.DPP_TEXT_PDF_VISION ?? "1") === "1";
          if (!text || isScanned || useVisionForTextPdf) {
            // Process every page (bounded) — questions are frequently NOT on the
            // first couple of cover / instruction pages.
            const visionCap = Math.max(fastPageCap, VISION_PAGE_CAP);
            const pageNumbers = Array.from(
              { length: Math.min(pageCount, visionCap) },
              (_, i) => i + 1
            );
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const readPage = async (pngBuffer, pageNumber) =>
              withTimeout(
                parseWithGeminiVision({
                  imageBuffer: pngBuffer,
                  mimeType: "image/png",
                  modelName: parserUsed,
                  pageNumber,
                  source: "dpp-ai",
                }),
                GEMINI_CALL_TIMEOUT_MS,
                `Gemini vision (page ${pageNumber})`
              );
            try {
              const startedAt = Date.now();
              let stoppedEarly = false;
              // Count pages we actually settled (success/failed/skipped) so the
              // stop event can report an honest "processed N of M" reason.
              let processedPages = 0;
              // Render + read ONE page at a time. Rendering lazily keeps peak
              // memory to a single page (avoids OOM-driven 502s), and the
              // wall-clock budget guarantees we return before the hosting
              // gateway times out — a partial-but-real 200 instead of a 502.
              for (const pageNumber of pageNumbers) {
                if (Date.now() - startedAt > PARSE_TIME_BUDGET_MS) {
                  stoppedEarly = true;
                  console.warn(`[parse-pdf] time budget hit — stopping at page ${pageNumber}/${pageNumbers.length}`);
                  break;
                }
                // Progress (additive, fire-and-forget): only start a page we
                // actually intend to process — i.e. after the time-budget break
                // check, so pages skipped by the budget are never "started".
                startPage(jobId, pageNumber);
                let pageFailed = false;
                let pngBuffer;
                try {
                  const oneRendered = await renderPagesToPng(req.file.buffer, [pageNumber], VISION_RENDER_SCALE);
                  pngBuffer = oneRendered.get(pageNumber);
                } catch (renderErr) {
                  console.warn(`[parse-pdf] render page ${pageNumber} failed: ${renderErr.message}`);
                }
                if (!pngBuffer) {
                  // Render threw or returned nothing — the page could not be
                  // rendered. Count it as completed-but-failed, then continue.
                  completePage(jobId, pageNumber, { failed: true });
                  processedPages++;
                  continue;
                }
                visionPageBuffers.set(pageNumber, pngBuffer);
                try {
                  const res = await readPage(pngBuffer, pageNumber);
                  questions.push(...res.questions);
                  mergeVisionAnswers(res.answers);
                  console.log(`[parse-pdf] vision page ${pageNumber} -> ${res.questions.length} question(s), ${res.answers.length} answer(s)`);
                } catch (pageErr) {
                  // A slow / failed page is skipped (not retried) so a single
                  // bad page can never push the request past the time budget.
                  pageFailed = true;
                  console.warn(`[parse-pdf] vision page ${pageNumber} skipped: ${pageErr.message}`);
                }
                // Exactly-once per processed page: settles success or readPage
                // failure into a single completePage emit.
                completePage(jobId, pageNumber, {
                  failed: pageFailed,
                  note: getGeminiKeyLabel() ? `Running on ${getGeminiKeyLabel()}` : "Running on Gemini vision",
                });
                processedPages++;
                await sleep(150); // gentle rate smoothing to avoid 429 bursts
              }
              if (stoppedEarly || pageCount > visionCap) {
                console.warn(`[parse-pdf] processed a subset of ${pageCount} page(s) (cap ${visionCap}, budget ${PARSE_TIME_BUDGET_MS}ms)`);
                // The job ended with unprocessed pages (time budget hit or the
                // PDF has more pages than the vision cap). Emit a terminal
                // `stopped` event with an honest "processed N of M" reason
                // instead of completing — completeJob is skipped for this job
                // because stopJob makes it terminal (see the guarded
                // completeJob before the success response). Additive /
                // fire-and-forget; extraction behaviour is unchanged.
                stopJob(jobId, {
                  reason: `Stopped after processing ${processedPages} of ${pageCount} page(s) within the time budget.`,
                });
              }
              // Fall back if vision produced nothing at all (blank/low-quality
              // scans, or the model returned an empty set for every page).
              if (questions.length === 0) {
                console.warn("[parse-pdf] Gemini vision returned 0 questions — falling back.");
                if (isGroqAvailable() && text) {
                  questions = await parseWithGroq(text);
                  parserUsed = "groq";
                } else if (text) {
                  questions = parseHeuristic(text);
                  parserUsed = "heuristic";
                }
              }
              return;
            } catch (e) {
              console.warn(`[parse-pdf] Gemini vision page parse failed, falling back to Groq: ${e.message}`);
              if (isGroqAvailable() && text) {
                questions = await parseWithGroq(text);
                parserUsed = "groq";
                return;
              }
              questions = parseHeuristic(text);
              parserUsed = "heuristic";
              return;
            }
          }

          // Text PDF: process page-by-page so the teacher sees GENUINE
          // per-page progress instead of one long wait that jumps 0% -> 100%.
          // The extractor already gives us each page's text; we parse each page
          // independently, trying Gemini first and falling back to Groq /
          // heuristic FOR THAT PAGE, so progress keeps advancing with real
          // results even when an AI call fails on a page. A wall-clock budget
          // stops us before the hosting gateway times out (partial 200, not 502).
          {
            const pages = extracted?.pages || [];
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const startedAt = Date.now();
            let stoppedEarly = false;
            let usedGemini = false;
            let usedGroq = false;
            let usedHeuristic = false;
            // Once Gemini fails once (e.g. quota 429 or a timeout), stop trying it
            // for the remaining pages — otherwise every page would eat the full
            // GEMINI_CALL_TIMEOUT_MS before falling back, making progress crawl.
            let geminiDead = false;

            for (const pg of pages) {
              if (Date.now() - startedAt > PARSE_TIME_BUDGET_MS) {
                stoppedEarly = true;
                console.warn(`[parse-pdf] text time budget hit — stopping at page ${pg.pageNumber}/${pages.length}`);
                break;
              }
              startPage(jobId, pg.pageNumber);
              let pageFailed = false;
              let pageNote = null; // which engine/key processed this page (for the UI)
              const pageText = (pg.text || "").trim();
              if (pageText) {
                let got = false;
                // 1) Try Gemini (best quality) — but skip it once it has died.
                if (!geminiDead) {
                  try {
                    const qs = await withTimeout(
                      parseWithGemini(pageText, { modelName: parserUsed, source: "dpp-ai" }),
                      GEMINI_CALL_TIMEOUT_MS,
                      `Gemini text (PDF page ${pg.pageNumber})`
                    );
                    questions.push(...qs);
                    usedGemini = true;
                    got = true;
                    // Show which key in the pool is currently running.
                    pageNote = getGeminiKeyLabel() ? `Running on ${getGeminiKeyLabel()}` : "Running on Gemini";
                  } catch (e1) {
                    geminiDead = true; // don't waste time on Gemini for later pages
                    console.warn(`[parse-pdf] Gemini page ${pg.pageNumber} failed; using fast parser for the rest: ${e1.message}`);
                  }
                }
                // 2) Fall back to Groq / heuristic for this page.
                if (!got) {
                  try {
                    if (isGroqAvailable()) {
                      questions.push(...(await parseWithGroq(pageText)));
                      usedGroq = true;
                      pageNote = "Running on Groq (fast parser)";
                    } else {
                      questions.push(...parseHeuristic(pageText));
                      usedHeuristic = true;
                      pageNote = "Running on Heuristic parser";
                    }
                  } catch (e2) {
                    try {
                      questions.push(...parseHeuristic(pageText));
                      usedHeuristic = true;
                      pageNote = "Running on Heuristic parser";
                    } catch {
                      pageFailed = true;
                    }
                  }
                }
              }
              // Real completion of this page — emits the live progress event.
              completePage(jobId, pg.pageNumber, { failed: pageFailed, note: pageNote });
              await sleep(120); // gentle rate smoothing between pages
            }

            // Reflect which engine actually produced the questions.
            parserUsed = usedGemini
              ? (process.env.GEMINI_MODEL || parserUsed)
              : usedGroq
              ? "groq"
              : usedHeuristic
              ? "heuristic"
              : parserUsed;

            // Safety net: if page-by-page produced nothing, try one whole-text pass.
            if (questions.length === 0 && text) {
              if (isGroqAvailable()) {
                try { questions = await parseWithGroq(text); parserUsed = "groq"; } catch { /* ignore */ }
              }
              if (questions.length === 0) { questions = parseHeuristic(text); parserUsed = "heuristic"; }
            }

            // Ended before all pages due to the time budget -> honest stop.
            if (stoppedEarly) {
              stopJob(jobId, { reason: `Stopped within the time budget after processing part of the document.` });
            }
            return;
          }
        }

        try {
          questions = await withTimeout(
            parseWithGemini(text, { modelName: parserUsed, source: "dpp-ai" }),
            GEMINI_CALL_TIMEOUT_MS,
            "Gemini text"
          );
          return;
        } catch (e) {
          console.warn(`[parse-pdf] Gemini text parse failed, falling back to Groq: ${e.message}`);
          if (isGroqAvailable()) {
            questions = await parseWithGroq(text);
            parserUsed = "groq";
            return;
          }
          questions = parseHeuristic(text);
          parserUsed = "heuristic";
        }
      };
      const tryRaw = () => {
        questions = parseHeuristic(text);
        parserUsed = "raw";
      };

      if (requestedMode === "groq") {
        await tryGroq();
      } else if (requestedMode === "gemini" || requestedMode === "ai" || requestedMode === "dpp") {
        // "AI Pro Max" — smart Gemini path (text + scanned/vision + images).
        if (!isGeminiAvailable()) {
          // Early exit before any page work — close the stream so a subscribed
          // client is not left hanging. Guarded so we never double-emit.
          if (!isTerminal(jobId)) stopJob(jobId, { reason: "AI Pro Max requested but GEMINI_API_KEY is not set on the server." });
          return res.status(400).json({ error: "AI Pro Max requested but GEMINI_API_KEY is not set on the server." });
        }
        await tryGeminiSmart();
      } else if (requestedMode === "heuristic") {
        tryHeuristic();
      } else if (requestedMode === "raw") {
        tryRaw();
      } else {
        // auto
        if (isGroqAvailable()) {
          try {
            await tryGroq();
            if (questions.length === 0) tryHeuristic();
          } catch (e) {
            console.warn("[parse-pdf] Groq failed, falling back to heuristic:", e.message);
            tryHeuristic();
          }
        } else {
          tryHeuristic();
        }
      }

      // ---- 2b. Match the solution / answer sheet (usually at the end of the
      // paper) back onto each question by question number. Works for every
      // parser so answers & explanations get filled even on the fast parsers. ----
      if (text && questions.length > 0) {
        try {
          const { questions: withSolutions, matched } = applySolutionSheet(questions, text);
          questions = withSolutions;
          if (matched > 0) {
            console.log(`[parse-pdf] solution sheet matched ${matched}/${questions.length} question(s)`);
          }
        } catch (e) {
          console.warn("[parse-pdf] solution sheet matching failed:", e.message);
        }
      }

      // ---- 2c. Vision answer-key linkage: attach the correct option + solution
      // that AI Pro Max read off the answer-key / solutions pages, matched by
      // question number (falls back to sequential order). ----
      if (visionAnswers.size > 0 && questions.length > 0) {
        let linked = 0;
        questions = questions.map((q, i) => {
          const num = Number.isInteger(q.number) ? q.number : i + 1;
          const sol = visionAnswers.get(num);
          if (!sol) return q;
          const next = { ...q };
          let did = false;
          if (sol.correctIndex != null && Array.isArray(next.options) && next.options.length > sol.correctIndex) {
            next.correctIndex = sol.correctIndex;
            did = true;
          }
          if (sol.explanation && !String(next.explanation || "").trim()) {
            next.explanation = sol.explanation;
            did = true;
          }
          if (did) linked++;
          return next;
        });
        if (linked > 0) console.log(`[parse-pdf] vision answer key linked ${linked}/${questions.length} question(s)`);
      }

      // ---- 2d. Crop each question's diagram out of its rendered page and
      // attach it as pageImageUrl (real per-question figures, not full pages). ----
      if (visionPageBuffers.size > 0 && questions.length > 0) {
        let cropped = 0;
        questions = await Promise.all(
          questions.map(async (q, i) => {
            if (!q.figureBox || !Number.isInteger(q.pageNumber)) return q;
            const pageBuf = visionPageBuffers.get(q.pageNumber);
            if (!pageBuf) return q;
            const cropBuf = await cropRegionToPng(pageBuf, q.figureBox);
            if (!cropBuf) return q;
            const name = `q${i + 1}`;
            try {
              await saveFigureImage({ docId: documentId, name, buffer: cropBuf });
              cropped++;
              return {
                ...q,
                hasFigure: true,
                pageImageUrl: `/api/documents/${documentId}/figures/${name}.png`,
              };
            } catch (e) {
              console.warn(`[parse-pdf] saveFigureImage q${i + 1} failed: ${e.message}`);
              return q;
            }
          })
        );
        if (cropped > 0) console.log(`[parse-pdf] cropped ${cropped} diagram(s) from pages`);
      }

      // ---- 2e. Persist the full-page snapshots the vision pass rendered, so the
      // admin can always re-crop a diagram from the ORIGINAL page (even if the
      // auto-crop cut it wrong). The manual crop tool loads these. ----
      if (visionPageBuffers.size > 0) {
        for (const [pageNumber, buf] of visionPageBuffers.entries()) {
          try {
            await savePageImage({ docId: documentId, pageNumber, buffer: buf });
          } catch (e) {
            console.warn(`[parse-pdf] save source page ${pageNumber} failed: ${e.message}`);
          }
        }
      }

      // ---- 3. Persist the uploaded asset so the document can be reviewed later ----
      let storageInfo = null;
      if (isImageUpload) {
        const saved = await savePageImage({ docId: documentId, pageNumber: 1, buffer: req.file.buffer });
        storageInfo = { path: saved.path, backend: saved.backend, sizeBytes: saved.sizeBytes };
      } else {
        try {
          storageInfo = await saveDocumentBytes({
            id: documentId,
            filename: req.file.originalname,
            buffer: req.file.buffer,
          });
        } catch (e) {
          console.error("[parse-pdf] PDF byte storage failed:", e.message);
          // Close the stream on this early exit so a subscribed client is not
          // left hanging. Guarded so we never double-emit a terminal event.
          if (!isTerminal(jobId)) stopJob(jobId, { reason: `Failed to save PDF bytes: ${e.message}` });
          return res.status(500).json({
            error: `Failed to save PDF bytes: ${e.message}`,
            parser: parserUsed,
            questions,
          });
        }
      }

      if (requestedMode === "raw" && !isImageUpload) {
        try {
          await storage.savePdfPages?.({
            pdfName: req.file.originalname || "upload.pdf",
            pages: extracted.pages,
          });
        } catch (e) {
          console.warn("[parse-pdf] savePdfPages failed:", e.message);
        }
      }

      await saveAsDocument(storageInfo.path, storageInfo.backend);

      // ---- 3b. Render & save page snapshots for questions that reference or contain diagrams ----
      const pageHasImageMap = new Map();
      if (extracted?.pages) {
        for (const page of extracted.pages) {
          pageHasImageMap.set(page.pageNumber, Boolean(page.hasImage));
        }
      }

      const figurePageSet = new Set();
      // (a) pages referenced by AI questions that carry page + figure metadata
      for (const q of questions) {
        if (!Number.isInteger(q.pageNumber)) continue;
        if (q.hasFigure || pageHasImageMap.get(q.pageNumber)) {
          figurePageSet.add(q.pageNumber);
        }
      }
      // (b) ANY page that actually contains an image/diagram — this makes the
      // fast parsers (AI Pro / Groq / heuristic) also capture diagrams
      // automatically instead of needing manual screenshots. The fallback
      // attach logic below links these snapshots to figure-referencing questions.
      // NOTE: Only add pages with images when at least one question on that page
      // was flagged hasFigure by the AI, otherwise every page on a scanned PDF
      // gets attached to every question (cluttering questions with no diagram).
      for (const [pageNumber, hasImage] of pageHasImageMap.entries()) {
        if (!hasImage) continue;
        // only include this page if at least one question actually references a figure on it
        const anyOnThisPage = questions.some(
          (q) => q.hasFigure && q.pageNumber === pageNumber
        );
        if (anyOnThisPage) figurePageSet.add(pageNumber);
      }
      // Bound the work so a figure-heavy paper can't OOM / time out the request.
      const figurePages = [...figurePageSet].sort((a, b) => a - b).slice(0, MAX_FIGURE_PAGES);

      const likelyFigureText = (q) => {
        const text = `${q?.text || ""} ${(Array.isArray(q?.options) ? q.options.join(" ") : "")}`.toLowerCase();
        return /figure|diagram|graph|chart|table|circuit|shown below|given below|image|illustration|labelled|labeling|labels?/.test(text);
      };

      // Build a map of page -> figure bounds for cropped rendering from extracted image metadata.
      const figureBoundsMap = new Map();
      if (extracted?.pages) {
        for (const pageNum of figurePages) {
          const pageData = extracted.pages.find((p) => p.pageNumber === pageNum);
          if (pageData && pageData.imageBounds && pageData.imageBounds.length > 0) {
            const union = pageData.imageBounds.reduce(
              (acc, item) => ({
                x0: Math.min(acc.x0, item.x0),
                y0: Math.min(acc.y0, item.y0),
                x1: Math.max(acc.x1, item.x1),
                y1: Math.max(acc.y1, item.y1),
              }),
              { ...pageData.imageBounds[0] }
            );
            figureBoundsMap.set(pageNum, [union.x0, union.y0, union.x1, union.y1]);
            console.log(`[parse-pdf] page ${pageNum} cropped render bounds: [${union.x0}, ${union.y0}, ${union.x1}, ${union.y1}]`);
          }
        }
      }

      const pageImageMap = {}; // pageNumber -> public URL
      if (isImageUpload) {
        pageImageMap[1] = `/api/documents/${documentId}/pages/1.png`;
      }
      const figureBudgetLeft = (Date.now() - parseStartedAt) < FIGURE_RENDER_BUDGET_MS;
      if (!figureBudgetLeft && figurePages.length > 0) {
        console.warn(`[parse-pdf] skipping inline figure render (time budget) — ${figurePages.length} page(s) can be cropped on demand later`);
      }
      if (figurePages.length > 0 && !isImageUpload && extracted?.pages && figureBudgetLeft) {
        try {
          console.log(`[parse-pdf] rendering ${figurePages.length} figure page(s):`, figurePages.join(", "));
          // Render all pages that reference figures. If vector image bounds
          // are present we'll crop via those; otherwise the pdf-render
          // pixel-fallback will auto-crop the non-white bbox.
          const rendered = await renderPagesToPng(req.file.buffer, figurePages, PDF_RENDER_SCALE, figureBoundsMap);
          console.log(`[parse-pdf] rendered ${rendered.size}/${figureBoundsMap.size} page(s), saving…`);
          for (const [pageNumber, pngBuf] of rendered) {
            try {
              const saved = await savePageImage({ docId: documentId, pageNumber, buffer: pngBuf });
              pageImageMap[pageNumber] = `/api/documents/${documentId}/pages/${pageNumber}.png`;
              console.log(`[parse-pdf] saved page ${pageNumber} (${pngBuf.length} bytes) → ${saved.path}`);
            } catch (e) {
              console.warn(`[parse-pdf] savePageImage p${pageNumber} failed:`, e.message);
            }
          }
        } catch (e) {
          console.warn("[parse-pdf] page rendering failed:", e.message);
        }
      }

      const fallbackFigurePages = [...figurePages];

      // Attach pageImageUrl to every question that has a saved snapshot
      questions = questions.map((q) => {
        // Preserve a precise per-question diagram crop if we already made one.
        if (q.pageImageUrl) return q;
        let pageNumber = Number.isInteger(q.pageNumber) ? q.pageNumber : null;
        let url = pageNumber ? pageImageMap[pageNumber] : null;

        if (!url && fallbackFigurePages.length > 0 && (q.hasFigure || likelyFigureText(q) || fallbackFigurePages.length === 1)) {
          const inferredPage = pageNumber || fallbackFigurePages.shift();
          if (inferredPage) {
            pageNumber = inferredPage;
            url = pageImageMap[inferredPage] || null;
          }
        }

        if (!url) return q;
        return {
          ...q,
          pageNumber: pageNumber || q.pageNumber,
          hasFigure: q.hasFigure || Boolean(pageHasImageMap.get(pageNumber || q.pageNumber)) || likelyFigureText(q),
          pageImageUrl: url,
        };
      });

      // ---- 4. Optionally save extracted questions (only if save=1) ----
      let questionsSaved = false;
      if (saveQuestions && questions.length > 0) {
        try {
          await saveQuestionsWithDocument(questions);
          questionsSaved = true;
        } catch (e) {
          console.error("[parse-pdf] addQuestions failed:", e.message);
        }
      }

      // Clean PDF-extraction artifacts (e.g. "√--x" -> "√x") then attach
      // documentId to every returned question so the frontend can link them on Save All.
      const questionsOut = questions.map((q) => ({ ...cleanQuestionArtifacts(q), documentId }));

      // ---- Terminal progress event (Component 3: parse-pdf instrumentation).
      // Emit the normal `complete` only if the job did not already reach a
      // terminal state (vision budget/cap stopJob, or an unreadable failJob).
      // This single guarded call covers every successful parser path:
      //   • non-vision fast paths (text / Groq / heuristic / raw) that emitted
      //     only the initial `total` now get their `complete` (completedCount
      //     === totalPages, percentage === 100);
      //   • the vision full-completion case (all pages processed) completes;
      //   • zero-page jobs yield the 0/0/100 terminal values.
      // Additive / fire-and-forget — the HTTP response below is unchanged.
      if (!isTerminal(jobId)) completeJob(jobId);

      res.json({
        documentId,
        parser: parserUsed,
        pageCount,
        textLength: text.length,
        isScanned: false,
        questionsCount: questions.length,
        questions: questionsOut,
        questionsSaved,
        saved: true, // PDF + document row are always saved now
      });
    } catch (e) {
      console.error("[parse-pdf] error:", e);
      // A thrown extraction error also leaves progress subscribers hanging.
      // Notify them with a terminal failure — guarded so we never double-emit a
      // terminal event if the job already reached one (complete/stopped/failure).
      if (jobId && !isTerminal(jobId)) {
        failJob(jobId, {
          message: "Could not read this file — it may be corrupted or password-protected.",
        });
      }
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- Crop/replace a saved page-image (admin only) ----
  // POST /api/admin/documents/:id/pages/:n/crop
  // multipart/form-data field `file` (PNG/JPEG) — replaces the stored page image
  r.post(
    "/documents/:id/pages/:n/crop",
    requireAdmin,
    uploadImage.single("file"),
    async (req, res) => {
      try {
        const docId = req.params.id;
        const pageNumber = parseInt(req.params.n, 10);
        if (!req.file || !req.file.buffer) return res.status(400).json({ error: "No file uploaded (field: file)" });
        if (!Number.isInteger(pageNumber) || pageNumber < 1) return res.status(400).json({ error: "Invalid page number" });
        const doc = await storage.getDocument?.(docId);
        if (!doc) return res.status(404).json({ error: "Document not found" });
        // Overwrite the saved page image with the provided buffer
        const saved = await savePageImage({ docId, pageNumber, buffer: req.file.buffer });
        return res.json({ ok: true, path: saved.path, url: `/api/documents/${docId}/pages/${pageNumber}.png` });
      } catch (e) {
        console.error("[admin crop] error:", e);
        return res.status(500).json({ error: String(e.message || e) });
      }
    }
  );

  // ---- Save a PER-QUESTION figure crop (admin only) ----
  // POST /api/admin/documents/:id/figures/crop
  // multipart/form-data field `file` (PNG). Stores a NEW unique figure image so
  // cropping one question never overwrites another question on the same page.
  // Returns { ok, url } — caller sets it as that question's pageImageUrl.
  r.post(
    "/documents/:id/figures/crop",
    requireAdmin,
    uploadImage.single("file"),
    async (req, res) => {
      try {
        const docId = req.params.id;
        if (!req.file || !req.file.buffer) return res.status(400).json({ error: "No file uploaded (field: file)" });
        const doc = await storage.getDocument?.(docId);
        if (!doc) return res.status(404).json({ error: "Document not found" });
        const name = "crop_" + crypto.randomBytes(5).toString("hex");
        await saveFigureImage({ docId, name, buffer: req.file.buffer });
        return res.json({ ok: true, url: `/api/documents/${docId}/figures/${name}.png` });
      } catch (e) {
        console.error("[admin figure crop] error:", e);
        return res.status(500).json({ error: String(e.message || e) });
      }
    }
  );

  // ---- Upload a standalone diagram image for a question (admin only) ----
  // POST /api/admin/upload-image
  // multipart/form-data field `file` (PNG/JPEG). Unlike the crop routes this
  // does NOT need a source PDF document — it lets an admin attach a diagram to
  // a manually-typed question. Stored under the synthetic "manual" doc bucket.
  // Returns { ok, url } — caller sets it as that question's pageImageUrl.
  r.post(
    "/upload-image",
    requireAdmin,
    uploadImage.single("file"),
    async (req, res) => {
      try {
        if (!req.file || !req.file.buffer) {
          return res.status(400).json({ error: "No file uploaded (field: file)" });
        }
        const docId = "manual";
        const name = "img_" + crypto.randomBytes(6).toString("hex");
        await saveFigureImage({ docId, name, buffer: req.file.buffer });
        return res.json({ ok: true, url: `/api/documents/${docId}/figures/${name}.png` });
      } catch (e) {
        console.error("[admin upload-image] error:", e);
        return res.status(500).json({ error: String(e.message || e) });
      }
    }
  );

  // ---- Serve a saved PDF (for inline review of figure questions) ----
  // GET /api/admin/documents/:id/pdf  — streams bytes inline
  // Browsers can append #page=N to jump to a specific page.
  r.get("/documents/:id/pdf", requireAdmin, async (req, res) => {
    try {
      const doc = await storage.getDocument?.(req.params.id);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const buf = await getPdfBytes(doc.storagePath, doc.storageBackend);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${(doc.filename || "document.pdf").replace(/[^\w.\-]+/g, "_")}"`
      );
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.send(buf);
    } catch (e) {
      console.error("[documents/:id/pdf] error:", e);
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ===== REFERRAL MANAGEMENT =====
  // Build a quick id -> profile map for name/role enrichment.
  async function profileMap() {
    const all = (await storage.getAllProfiles?.()) || [];
    const map = {};
    for (const p of all) map[String(p.id)] = p;
    return map;
  }

  // Dashboard summary cards.
  r.get("/referral/summary", requireAdmin, async (_req, res) => {
    try {
      const [referrals, commissions] = await Promise.all([
        storage.getAllReferrals?.() ?? [],
        storage.getAllCommissions?.() ?? [],
      ]);
      const totals = summarizeCommissions(commissions);
      res.json({
        totalReferralUsers: referrals.length,
        teachersReferred: referrals.filter((x) => x.referredRole === "teacher").length,
        studentsReferred: referrals.filter((x) => x.referredRole === "student").length,
        pendingCommission: totals.pending,
        approvedCommission: totals.approved,
        paidCommission: totals.paid,
        totalCommissionAmount: totals.lifetime,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Referral list: referrer name, code, referred user, role, signup date, status.
  r.get("/referral/list", requireAdmin, async (_req, res) => {
    try {
      const [referrals, map] = await Promise.all([
        storage.getAllReferrals?.() ?? [],
        profileMap(),
      ]);
      const rows = referrals.map((ref) => ({
        id: ref.id,
        referrerName: map[String(ref.referrerId)]?.name || "User",
        referralCode: ref.referralCode,
        referredUser: map[String(ref.referredUserId)]?.name || "User",
        role: ref.referredRole || map[String(ref.referredUserId)]?.role || "student",
        signupDate: ref.createdAt,
        status: "joined",
      }));
      res.json({ referrals: rows });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Commission list with referrer + buyer names.
  r.get("/referral/commissions", requireAdmin, async (_req, res) => {
    try {
      const [commissions, map] = await Promise.all([
        storage.getAllCommissions?.() ?? [],
        profileMap(),
      ]);
      const rows = commissions.map((c) => ({
        id: c.id,
        referrer: map[String(c.referrerId)]?.name || "User",
        referrerId: c.referrerId,
        buyer: map[String(c.buyerId)]?.name || "User",
        orderId: c.orderId,
        purchaseAmount: c.purchaseAmount,
        commissionPercent: c.commissionPercent,
        commissionAmount: c.commissionAmount,
        status: c.status,
        date: c.createdAt,
      }));
      res.json({ commissions: rows });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Update a single commission's status (approve / cancel / re-pending).
  r.post("/referral/commissions/:id/status", requireAdmin, async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!["pending", "approved", "paid", "cancelled"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }
      const updated = await storage.updateCommission(req.params.id, { status });
      if (!updated) return res.status(404).json({ error: "Commission not found" });
      res.json({ commission: updated });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Cancel commission for a refunded order.
  r.post("/referral/refund", requireAdmin, async (req, res) => {
    try {
      const { orderId } = req.body || {};
      if (!orderId) return res.status(400).json({ error: "orderId is required" });
      const cancelled = await cancelCommissionForOrder(storage, orderId);
      res.json({ commission: cancelled });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Payout history.
  r.get("/referral/payouts", requireAdmin, async (_req, res) => {
    try {
      const [payouts, map] = await Promise.all([
        storage.getAllPayouts?.() ?? [],
        profileMap(),
      ]);
      const rows = payouts.map((p) => ({
        id: p.id,
        userId: p.userId,
        userName: map[String(p.userId)]?.name || "User",
        amount: p.amount,
        transactionNote: p.transactionNote,
        paidAt: p.paidAt,
      }));
      res.json({ payouts: rows });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Pay out a teacher: marks their APPROVED commissions as paid and records a
  // payout row. If `amount` is omitted, pays the full approved balance.
  r.post("/referral/payout", requireAdmin, async (req, res) => {
    try {
      const { userId, transactionNote } = req.body || {};
      if (!userId) return res.status(400).json({ error: "userId is required" });

      const commissions = (await storage.getCommissionsByReferrer?.(userId)) || [];
      const approved = commissions.filter((c) => c.status === "approved");
      if (approved.length === 0) {
        return res.status(400).json({ error: "No approved commissions to pay out." });
      }

      let total = 0;
      for (const c of approved) {
        await storage.updateCommission(c.id, { status: "paid" });
        total += Number(c.commissionAmount) || 0;
      }
      total = Math.round(total * 100) / 100;

      const payout = await storage.addPayout({
        userId: String(userId),
        amount: total,
        transactionNote: transactionNote || `Payout for ${approved.length} commission(s)`,
        paidAt: new Date().toISOString(),
      });

      res.json({ payout, paidCount: approved.length, amount: total });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ===== SUBSCRIPTIONS & REVENUE =====

  // List every user who has (or had) a subscription, newest first. Supports a
  // free-text search via ?q= matching email, name, user id, plan, payment id,
  // or order id so an admin can paste a buyer's email and jump straight to them.
  r.get("/subscriptions", requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || "").trim().toLowerCase();
      const [profiles, payments] = await Promise.all([
        storage.getAllProfiles?.() ?? [],
        storage.getAllPayments?.() ?? [],
      ]);

      // Latest payment per user for enrichment (payments are already newest-first).
      const lastPaymentByUser = {};
      const paymentCountByUser = {};
      const totalPaidByUser = {};
      for (const p of payments) {
        const uid = String(p.userId || "");
        if (!uid) continue;
        if (!lastPaymentByUser[uid]) lastPaymentByUser[uid] = p;
        paymentCountByUser[uid] = (paymentCountByUser[uid] || 0) + 1;
        totalPaidByUser[uid] = (totalPaidByUser[uid] || 0) + (Number(p.amount) || 0);
      }

      const now = Date.now();
      let rows = profiles
        .filter((p) => p.subscription && (p.subscription.active || p.subscription.plan || p.subscription.razorpayPaymentId))
        .map((p) => {
          const uid = String(p.id);
          const sub = p.subscription || {};
          const last = lastPaymentByUser[uid] || null;
          const validUntil = sub.validUntil || last?.validUntil || null;
          const expired = validUntil ? new Date(validUntil).getTime() < now : false;
          return {
            userId: uid,
            email: p.email || last?.email || null,
            name: p.name || last?.name || null,
            role: p.role || last?.role || "student",
            plan: sub.plan || last?.plan || null,
            active: Boolean(sub.active) && !expired,
            expired,
            validUntil,
            razorpayPaymentId: sub.razorpayPaymentId || last?.paymentId || null,
            lastOrderId: last?.orderId || null,
            lastAmount: last?.amount ?? null,
            totalPaid: Math.round((totalPaidByUser[uid] || 0) * 100) / 100,
            paymentCount: paymentCountByUser[uid] || 0,
            purchasedAt: last?.createdAt || null,
          };
        });

      if (q) {
        rows = rows.filter((row) =>
          [row.email, row.name, row.userId, row.plan, row.razorpayPaymentId, row.lastOrderId]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(q)),
        );
      }

      // Newest purchase on top; users without a recorded payment date sink down.
      rows.sort((a, b) => {
        const ta = a.purchasedAt ? new Date(a.purchasedAt).getTime() : 0;
        const tb = b.purchasedAt ? new Date(b.purchasedAt).getTime() : 0;
        return tb - ta;
      });

      const activeCount = rows.filter((x) => x.active).length;
      res.json({
        subscriptions: rows,
        summary: {
          total: rows.length,
          active: activeCount,
          expired: rows.length - activeCount,
        },
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Revenue dashboard: aggregates the payments ledger into totals, by-plan,
  // by-month, and a recent-transactions feed (newest first).
  r.get("/revenue", requireAdmin, async (_req, res) => {
    try {
      const payments = (await storage.getAllPayments?.()) || [];
      const captured = payments.filter((p) => (p.status || "captured") === "captured");

      let totalRevenue = 0;
      const byPlan = {};
      const byMonth = {};
      const byRole = { teacher: { count: 0, amount: 0 }, student: { count: 0, amount: 0 } };
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      let thisMonthRevenue = 0;

      for (const p of captured) {
        const amount = Number(p.amount) || 0;
        totalRevenue += amount;
        const planKey = p.planLabel || p.plan || "unknown";
        byPlan[planKey] = byPlan[planKey] || { count: 0, amount: 0 };
        byPlan[planKey].count += 1;
        byPlan[planKey].amount += amount;
        const roleKey = p.role === "teacher" ? "teacher" : "student";
        byRole[roleKey].count += 1;
        byRole[roleKey].amount += amount;
        if (p.createdAt) {
          const d = new Date(p.createdAt);
          const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          byMonth[mk] = (byMonth[mk] || 0) + amount;
          if (mk === monthKey) thisMonthRevenue += amount;
        }
      }

      const round2 = (n) => Math.round(n * 100) / 100;
      const recent = captured.slice(0, 25).map((p) => ({
        id: p.id,
        email: p.email,
        name: p.name,
        plan: p.planLabel || p.plan,
        amount: round2(Number(p.amount) || 0),
        currency: p.currency || "INR",
        paymentId: p.paymentId,
        orderId: p.orderId,
        createdAt: p.createdAt,
      }));

      res.json({
        currency: payments[0]?.currency || "INR",
        totalRevenue: round2(totalRevenue),
        thisMonthRevenue: round2(thisMonthRevenue),
        totalTransactions: captured.length,
        averageOrderValue: captured.length ? round2(totalRevenue / captured.length) : 0,
        byPlan: Object.fromEntries(
          Object.entries(byPlan).map(([k, v]) => [k, { count: v.count, amount: round2(v.amount) }]),
        ),
        byRole: {
          teacher: { count: byRole.teacher.count, amount: round2(byRole.teacher.amount) },
          student: { count: byRole.student.count, amount: round2(byRole.student.amount) },
        },
        byMonth: Object.fromEntries(
          Object.entries(byMonth)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, round2(v)]),
        ),
        recent,
      });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ===== USERS MANAGEMENT =====

  // List every registered user (teachers + students) with join date + status.
  r.get("/users", requireAdmin, async (_req, res) => {
    try {
      const profiles = (await storage.getAllProfiles?.()) || [];
      const users = profiles.map((p) => ({
        id: String(p.id),
        name: p.name || null,
        email: p.email || null,
        phone: p.phone || p.mobile || null,
        role: p.role || "student",
        classLevel: p.classLevel || null,
        createdAt: p.createdAt || null,
        suspended: Boolean(p.suspended),
        subscribed: Boolean(p.subscription?.active),
        plan: p.subscription?.plan || null,
      }));
      // Newest first when createdAt is present.
      users.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      res.json({ users });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Suspend / un-suspend a user (blocks login while suspended).
  r.post("/users/:id/suspend", requireAdmin, async (req, res) => {
    try {
      const suspended = Boolean(req.body?.suspended);
      const profile = await storage.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: "User not found" });
      const updated = await storage.saveProfile(req.params.id, { ...profile, suspended });
      res.json({ ok: true, suspended: Boolean(updated?.suspended ?? suspended) });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Permanently delete a user from the database.
  r.delete("/users/:id", requireAdmin, async (req, res) => {
    try {
      if (!storage.deleteUser) return res.status(501).json({ error: "Delete not supported by storage" });
      await storage.deleteUser(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // Multer error handler (file too big, wrong mime)
  r.use((err, _req, res, _next) => {
    if (err) return res.status(400).json({ error: String(err.message || err) });
  });

  return r;
}
