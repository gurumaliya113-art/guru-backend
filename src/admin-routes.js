// Admin routes — mounted at /api/admin/* by server/src/index.js.
import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import { adminLogin, adminLogout, requireAdmin } from "./auth.js";
import { parseHeuristic } from "./parsers/heuristic.js";
import { parseWithGemini, parseWithGeminiVision, isGeminiAvailable } from "./parsers/gemini.js";
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
import { summarizeCommissions, cancelCommissionForOrder } from "./referral.js";

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

      let questions = [];
      let parserUsed = "heuristic";

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
      const tryGemini = async () => {
        questions = await parseWithGemini(text, { modelName: process.env.GEMINI_MODEL || "gemini-3-flash-preview", source: "pdf-ai" });
        parserUsed = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
      };
      const tryDppGemini = async () => {
        questions = [];
        parserUsed = process.env.GEMINI_DPP_MODEL || process.env.GEMINI_MODEL || "gemini-3-flash-preview";
        const fastPageCap = Number(process.env.DPP_FAST_PAGE_CAP || 2);

        if (isImageUpload) {
          try {
            questions = await parseWithGeminiVision({
              imageBuffer: req.file.buffer,
              mimeType: getMimeType(req.file.originalname, req.file.mimetype),
              modelName: parserUsed,
              pageNumber: 1,
              source: "dpp-ai",
            });
            return;
          } catch (e) {
            console.warn(`[parse-pdf] Gemini vision failed, falling back to heuristic: ${e.message}`);
            questions = parseHeuristic(text);
            parserUsed = "heuristic";
            return;
          }
        }

        if (fileType === "pdf") {
          if (!text || isScanned) {
            const pageNumbers = Array.from({ length: Math.min(pageCount, fastPageCap) }, (_, i) => i + 1);
            const rendered = await renderPagesToPng(req.file.buffer, pageNumbers, 1.8);
            try {
              for (const [pageNumber, pngBuffer] of rendered.entries()) {
                const pageQuestions = await parseWithGeminiVision({
                  imageBuffer: pngBuffer,
                  mimeType: "image/png",
                  modelName: parserUsed,
                  pageNumber,
                  source: "dpp-ai",
                });
                questions.push(...pageQuestions);
              }
              if (pageCount > fastPageCap) {
                console.warn(`[parse-pdf] fast DPP cap hit: rendered ${fastPageCap}/${pageCount} pages to keep the upload responsive`);
              }
              return;
            } catch (e) {
              console.warn(`[parse-pdf] Gemini vision page parse failed, falling back to Groq: ${e.message}`);
              if (isGroqAvailable()) {
                questions = await parseWithGroq(text);
                parserUsed = "groq";
                return;
              }
              questions = parseHeuristic(text);
              parserUsed = "heuristic";
              return;
            }
          }

          try {
            questions = await parseWithGemini(text, {
              modelName: parserUsed,
              source: "dpp-ai",
            });
            return;
          } catch (e) {
            console.warn(`[parse-pdf] Gemini text PDF parse failed, falling back to Groq: ${e.message}`);
            if (isGroqAvailable()) {
              questions = await parseWithGroq(text);
              parserUsed = "groq";
              return;
            }
            questions = parseHeuristic(text);
            parserUsed = "heuristic";
            return;
          }
        }

        try {
          questions = await parseWithGemini(text, { modelName: parserUsed, source: "dpp-ai" });
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

      if (requestedMode === "dpp") {
        await tryDppGemini();
      } else if (requestedMode === "groq") {
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
      for (const q of questions) {
        if (!Number.isInteger(q.pageNumber)) continue;
        if (q.hasFigure || pageHasImageMap.get(q.pageNumber)) {
          figurePageSet.add(q.pageNumber);
        }
      }
      const figurePages = [...figurePageSet];

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
      if (figurePages.length > 0 && !isImageUpload && extracted?.pages) {
        try {
          console.log(`[parse-pdf] rendering ${figurePages.length} figure page(s):`, figurePages.join(", "));
          // Render all pages that reference figures. If vector image bounds
          // are present we'll crop via those; otherwise the pdf-render
          // pixel-fallback will auto-crop the non-white bbox.
          const rendered = await renderPagesToPng(req.file.buffer, figurePages, 1.8, figureBoundsMap);
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

  // Multer error handler (file too big, wrong mime)
  r.use((err, _req, res, _next) => {
    if (err) return res.status(400).json({ error: String(err.message || err) });
  });

  return r;
}
