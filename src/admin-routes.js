// Admin routes — mounted at /api/admin/* by server/src/index.js.
import { Router } from "express";
import multer from "multer";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");
import crypto from "crypto";
import { adminLogin, adminLogout, requireAdmin } from "./auth.js";
import { parseHeuristic } from "./parsers/heuristic.js";
import { parseWithGemini, isGeminiAvailable } from "./parsers/gemini.js";

const upload = multer({
  storage: multer.memoryStorage(), // we never persist the PDF — only its extracted text
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are supported"));
    }
  },
});

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
    res.json({ ok: true, geminiAvailable: isGeminiAvailable() });
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

  r.delete("/questions/:id", requireAdmin, async (req, res) => {
    try {
      await storage.deleteQuestion(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---- PDF upload + parse ----
  // POST /api/admin/parse-pdf  (multipart form-data, field "file", optional "mode")
  // Returns: { questions: [...], textLength, parser, pageCount }
  // mode = "heuristic" (default) | "ai"
  r.post("/parse-pdf", requireAdmin, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded (field: file)" });
    try {
      const parser = new PDFParse({ data: req.file.buffer });
      const parsed = await parser.getText();
      const text = parsed.text || "";
      const mode = (req.body?.mode || req.query?.mode || "heuristic").toLowerCase();

      let questions = [];
      let parserUsed = "heuristic";
      if (mode === "ai") {
        if (!isGeminiAvailable()) {
          return res.status(400).json({
            error: "AI mode requested but GEMINI_API_KEY is not set in server/.env",
          });
        }
        questions = await parseWithGemini(text);
        parserUsed = "gemini-1.5-flash";
      } else {
        questions = parseHeuristic(text);
      }

      res.json({
        parser: parserUsed,
        pageCount: parsed.numpages,
        textLength: text.length,
        questions,
      });
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
