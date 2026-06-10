// Admin routes — mounted at /api/admin/* by server/src/index.js.
import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import { adminLogin, adminLogout, requireAdmin } from "./auth.js";
import { parseHeuristic } from "./parsers/heuristic.js";
import { parseWithGemini, isGeminiAvailable } from "./parsers/gemini.js";
import { parseWithGroq, isGroqAvailable } from "./parsers/groq.js";
import { extractPdfPages } from "./parsers/pdf-extract.js";
import { extractRawPdfPages } from "./parsers/pdf-raw.js";
import { extractDocxPages } from "./parsers/docx-extract.js";
import { renderPagesToPng } from "./parsers/pdf-render.js";
import {
  saveDocumentBytes,
  getPdfBytes,
  savePageImage,
  newDocumentId,
} from "./storage/pdf-storage.js";

const upload = multer({
  storage: multer.memoryStorage(), // we never persist the PDF — only its extracted text
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    if (
      file.mimetype === "application/pdf" ||
      lower.endsWith(".pdf") ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      lower.endsWith(".docx") ||
      file.mimetype === "application/msword" ||
      lower.endsWith(".doc")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF and Word documents (.doc, .docx) are supported"));
    }
  },
});

function getFileType(filename) {
  const lower = (filename || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".doc")) return "doc";
  return "unknown";
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

  // ---- PDF upload + parse (full pipeline) ----
  // POST /api/admin/parse-pdf
  //   multipart form-data, field "file"
  //   optional: mode = "auto" (default) | "groq" | "gemini" | "heuristic"
  //   optional: save = "1" (persist PDF + document + questions)  | "0" (preview only)
  //   optional: subject, examType, classLevel, notes  (metadata for the document)
  //
  // Returns: { documentId?, parser, pageCount, textLength, isScanned, questions, saved }
  r.post("/parse-pdf", requireAdmin, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded (field: file)" });

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
      // ---- 1. Extract text from the uploaded document per-page ----
      const fileType = getFileType(req.file.originalname);
      console.log(`[parse-pdf] Starting extraction for ${fileType} with mode: ${requestedMode}`);
      const extracted = fileType === "pdf"
        ? requestedMode === "raw"
          ? await extractRawPdfPages(req.file.buffer)
          : await extractPdfPages(req.file.buffer)
        : await extractDocxPages(req.file.buffer);
      console.log(`[parse-pdf] Extraction complete: ${extracted.pageCount} pages, ${extracted.textLength} chars`);
      const text = extracted.fullText.trim();
      const pageCount = extracted.pageCount;
      const pagesHaveImages = extracted.pages.some((p) => p.hasImage);
      const totalChars = extracted.pages.reduce((s, p) => s + (p.text?.length || 0), 0);
      const isScanned = fileType === "pdf" && totalChars < 100;

      if (isScanned) {
        return res.status(422).json({
          error: "This PDF appears to be scanned (no extractable text). OCR is not yet enabled — upload a digital/text PDF, or enable an OCR worker.",
          isScanned: true,
          pageCount,
          textLength: text.length,
        });
      }

      // ---- 2. Decide which parser to use ----
      // auto: groq if available, else heuristic. Gemini only if explicitly asked.
      let parserUsed;
      let questions = [];
      const tryGroq = async () => {
        questions = await parseWithGroq(text);
        parserUsed = "groq";
      };
      const tryHeuristic = () => {
        questions = parseHeuristic(text);
        parserUsed = "heuristic";
      };
      const tryGemini = async () => {
        questions = await parseWithGemini(text);
        parserUsed = "gemini";
      };
      const tryRaw = () => {
        questions = parseHeuristic(text);
        parserUsed = "raw";
      };

      if (requestedMode === "groq") {
        await tryGroq();
      } else if (requestedMode === "gemini" || requestedMode === "ai") {
        if (!isGeminiAvailable()) {
          return res.status(400).json({ error: "Gemini mode requested but GEMINI_API_KEY is not set." });
        }
        await tryGemini();
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

      // ---- 3. Always persist the PDF + documents row (so uploads are tracked) ----
      const documentId = newDocumentId();
      let storageInfo;
      try {
        storageInfo = await saveDocumentBytes({
          id: documentId,
          filename: req.file.originalname,
          buffer: req.file.buffer,
        });
      } catch (e) {
        console.error("[parse-pdf] PDF byte storage failed:", e.message);
        return res.status(500).json({
          error: `Failed to save PDF bytes: ${e.message}`,
          parser: parserUsed,
          questions,
        });
      }

      if (requestedMode === "raw") {
        try {
          await storage.savePdfPages?.({
            pdfName: req.file.originalname || "upload.pdf",
            pages: extracted.pages,
          });
        } catch (e) {
          console.warn("[parse-pdf] savePdfPages failed:", e.message);
        }
      }

      const doc = {
        id: documentId,
        filename: req.file.originalname || "upload.pdf",
        storagePath: storageInfo.path,
        storageBackend: storageInfo.backend,
        sizeBytes: storageInfo.sizeBytes,
        pageCount,
        textLength: text.length,
        isScanned: false,
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

      // ---- 3b. Render & save PNG snapshots of pages that have figure-questions ----
      // We snapshot only the pages where at least one question has hasFigure=true
      // (or where the page itself contains an image). Saves ~10× space vs. all pages.
      const figurePageSet = new Set();
      for (const q of questions) {
        if (q.hasFigure && Number.isInteger(q.pageNumber)) figurePageSet.add(q.pageNumber);
      }
      for (const p of extracted.pages) {
        if (p.hasImage) figurePageSet.add(p.pageNumber);
      }
      const figurePages = [...figurePageSet];

      const pageImageMap = {}; // pageNumber -> public URL
      if (figurePages.length > 0) {
        try {
          console.log(`[parse-pdf] rendering ${figurePages.length} figure page(s):`, figurePages.join(", "));
          const rendered = await renderPagesToPng(req.file.buffer, figurePages, 1.8);
          console.log(`[parse-pdf] rendered ${rendered.size}/${figurePages.length} page(s), saving…`);
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

      // Attach pageImageUrl to every question that has a saved snapshot
      questions = questions.map((q) => {
        const url = q.pageNumber ? pageImageMap[q.pageNumber] : null;
        return url ? { ...q, pageImageUrl: url } : q;
      });

      // ---- 4. Optionally save extracted questions (only if save=1) ----
      let questionsSaved = false;
      if (saveQuestions && questions.length > 0) {
        const linked = questions.map((q) => ({
          ...q,
          id: q.id || "q_" + crypto.randomBytes(4).toString("hex"),
          documentId,
          classLevel: q.classLevel || meta.classLevel || undefined,
          createdAt: q.createdAt || new Date().toISOString(),
        }));
        try {
          await storage.addQuestions(linked);
          questionsSaved = true;
        } catch (e) {
          console.error("[parse-pdf] addQuestions failed:", e.message);
        }
      }

      // Attach documentId to every returned question so the frontend can link them on Save All
      const questionsOut = questions.map((q) => ({ ...q, documentId }));

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
      res.status(500).json({ error: String(e.message || e) });
    }
  });

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

  // Multer error handler (file too big, wrong mime)
  r.use((err, _req, res, _next) => {
    if (err) return res.status(400).json({ error: String(err.message || err) });
  });

  return r;
}
