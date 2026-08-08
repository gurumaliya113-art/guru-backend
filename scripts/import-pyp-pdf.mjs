// =============================================================
//  Import previous-year-paper PDFs as real-time MOCK tests (pyps).
//
//  - Extracts text from each PDF (scripts/pyp-pdfs/*.pdf)
//  - Parses questions with Groq (free)
//  - Renders + saves page images for figure/diagram questions
//  - Applies an optional answer key from a sidecar <name>.meta.json
//  - Inserts a pyp row via the app's storage (shows at /pyp)
//
//  Usage (from backend/):
//    node scripts/import-pyp-pdf.mjs           # import all PDFs
//    node scripts/import-pyp-pdf.mjs --dry     # parse only, no insert
//
//  See scripts/pyp-pdfs/README.md for the meta.json format.
// =============================================================
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

import { supabase } from "../src/supabase.js";
import { supabaseStorage } from "../src/storage/supabase.js";
import { jsonStorage } from "../src/storage/json.js";
import { extractPdfPages } from "../src/parsers/pdf-extract.js";
import { parseWithGroq, isGroqAvailable } from "../src/parsers/groq.js";
import { parseWithGemini, parseWithGeminiVision, isGeminiAvailable } from "../src/parsers/gemini.js";
import { parseHeuristic } from "../src/parsers/heuristic.js";
import { renderPagesToPng } from "../src/parsers/pdf-render.js";
import { savePageImage, newDocumentId } from "../src/storage/pdf-storage.js";

const DRY = process.argv.includes("--dry");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).toLowerCase();
const useSupabase = process.env.STORAGE === "supabase" && supabase;
const storage = useSupabase ? supabaseStorage : jsonStorage;
const DIR = path.join(__dirname, "pyp-pdfs");
const newId = (p) => p + "_" + crypto.randomBytes(5).toString("hex");

console.log(`[pyp-pdf] storage = ${useSupabase ? "supabase" : "json"}${DRY ? " (DRY RUN)" : ""}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a promise-returning fn on transient errors (network blips, 503, 429).
async function withRetry(fn, { tries = 6, baseDelay = 3000, label = "op" } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = (e?.message || String(e)).toLowerCase();
      const isRate = msg.includes("429") || msg.includes("rate limit") || msg.includes("quota");
      const transient = isRate || msg.includes("fetch failed") || msg.includes("503") ||
        msg.includes("timeout") || msg.includes("econnreset") ||
        msg.includes("network") || msg.includes("socket") || msg.includes("500");
      if (i === tries - 1 || !transient) throw e;
      // Rate-limit errors need a longer cooldown (free tier ~per-minute window).
      const delay = isRate ? 25000 + i * 5000 : baseDelay * (i + 1);
      console.warn(`    ${label} ${isRate ? "rate-limited" : "transient error"} (try ${i + 1}/${tries}) — waiting ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Throttle between AI calls to stay under the free-tier per-minute limit.
const THROTTLE_MS = 4500;

const FORCE = process.argv.includes("--force");
const CACHE_DIR = path.join(__dirname, ".pyp-pdf-cache");
const IMPORTED = path.join(__dirname, ".pyp-pdf-imported.json");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const cachePath = (file) => path.join(CACHE_DIR, file.replace(/[^a-z0-9]+/gi, "_") + ".json");
function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(cachePath(file), "utf-8")); } catch { return null; }
}
function saveCache(file, questions) {
  try { fs.writeFileSync(cachePath(file), JSON.stringify(questions, null, 2)); } catch {}
}
function loadImported() { try { return new Set(JSON.parse(fs.readFileSync(IMPORTED, "utf-8"))); } catch { return new Set(); } }
function saveImported(s) { try { fs.writeFileSync(IMPORTED, JSON.stringify([...s], null, 2)); } catch {} }

// Map an answer-key entry ("A"/"b"/2/"2") to a 0-based correctIndex, or null.
function answerToIndex(a) {
  if (a == null || a === "") return null;
  const s = String(a).trim().toUpperCase();
  if (/^[A-D]$/.test(s)) return s.charCodeAt(0) - 65; // A->0 .. D->3
  const n = parseInt(s, 10);
  if (Number.isInteger(n) && n >= 1 && n <= 4) return n - 1; // 1->0 .. 4->3
  return null;
}

function normaliseQuestion(q) {
  let options = Array.isArray(q.options) ? q.options.map((o) => String(o ?? "").trim()) : [];
  options = options.slice(0, 4);
  while (options.length < 4) options.push("");
  return {
    id: newId("q"),
    subject: q.subject || "Physics",
    topic: q.topic || "",
    text: String(q.text || "").trim(),
    options,
    correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
    explanation: String(q.explanation || "").trim(),
    difficulty: ["Easy", "Moderate", "Hard"].includes(q.difficulty) ? q.difficulty : "Moderate",
    type: /numer/i.test(q.type || "") ? "Numerical" : "MCQ",
    examType: Array.isArray(q.examType) && q.examType.length ? q.examType : ["NEET"],
    pageNumber: Number.isInteger(q.pageNumber) ? q.pageNumber : null,
    hasFigure: Boolean(q.hasFigure),
    createdAt: new Date().toISOString(),
  };
}

// Render every page and ask Gemini Vision to read the questions off the image.
// Best path for scanned / image-only PDFs where text extraction is poor.
async function parseViaVision(pdfBuffer, extracted) {
  const pageNumbers = (extracted.pages || []).map((p) => p.pageNumber);
  if (pageNumbers.length === 0) return [];

  console.log(`  rendering ${pageNumbers.length} page(s) for Gemini Vision…`);
  let rendered;
  try {
    rendered = await renderPagesToPng(pdfBuffer, pageNumbers, 2.0, null);
  } catch (e) {
    console.warn(`  vision render failed: ${e.message}`);
    return [];
  }

  const all = [];
  let first = true;
  for (const [pageNumber, pngBuf] of rendered) {
    if (!first) await sleep(THROTTLE_MS);
    first = false;
    try {
      const qs = await withRetry(() => parseWithGeminiVision({
        imageBuffer: pngBuf,
        mimeType: "image/png",
        pageNumber,
        source: "pyp-vision",
      }), { label: `vision p${pageNumber}` });
      for (const q of qs) all.push({ ...q, pageNumber });
      process.stdout.write(`    page ${pageNumber}: ${qs.length} q\n`);
    } catch (e) {
      console.warn(`    vision page ${pageNumber} failed: ${e.message}`);
    }
  }
  return all;
}

// Split per-page text into chunks under maxChars (no page is split), so a
// large paper (100k+ chars) is parsed fully instead of being truncated to the
// model's 30k input cap (which would drop most questions).
function chunkPages(pages, maxChars = 22000) {
  const chunks = [];
  let cur = "";
  for (const p of pages || []) {
    const seg = `\n\n===== PAGE ${p.pageNumber}${p.hasImage ? " [contains image]" : ""} =====\n\n${p.text}`;
    if (cur.length + seg.length > maxChars && cur) {
      chunks.push(cur);
      cur = "";
    }
    cur += seg;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// Parse a long text PDF chunk-by-chunk with Gemini so every question is captured.
async function parseTextChunked(extracted) {
  const chunks = chunkPages(extracted.pages, 22000);
  console.log(`  Gemini text in ${chunks.length} chunk(s)…`);
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    try {
      const qs = await withRetry(() => parseWithGemini(chunks[i], { source: "pyp-ai" }), { label: `chunk ${i + 1}` });
      all.push(...qs);
      process.stdout.write(`    chunk ${i + 1}/${chunks.length}: ${qs.length} q (total ${all.length})\n`);
    } catch (e) {
      console.warn(`    chunk ${i + 1} failed: ${e.message}`);
    }
  }
  return all;
}

// Choose the best available parser. Returns a raw question array.
//   scanned PDF + Gemini  -> Gemini Vision per page (most accurate)
//   else Gemini text (chunked) -> Groq -> heuristic (free local) fallbacks
async function parseQuestions(pdfBuffer, extracted) {
  const avgPerPage = extracted.pageCount ? extracted.textLength / extracted.pageCount : 0;
  const scanned = avgPerPage < 150;

  if (scanned && isGeminiAvailable()) {
    console.log(`  scanned PDF (~${Math.round(avgPerPage)} chars/page) — using Gemini Vision…`);
    const visionQs = await parseViaVision(pdfBuffer, extracted);
    if (visionQs.length) return visionQs;
    console.log(`  vision returned 0 — falling back to text parsers`);
  }

  if (isGeminiAvailable()) {
    try {
      const qs = await parseTextChunked(extracted);
      if (qs.length) return qs;
      console.log(`  Gemini returned 0 — trying next parser`);
    } catch (e) {
      console.warn(`  Gemini failed: ${e.message}`);
    }
  }

  if (isGroqAvailable()) {
    try {
      console.log(`  parsing with Groq…`);
      const parsed = await parseWithGroq(extracted.fullText);
      const qs = parsed?.questions || parsed || [];
      if (qs.length) return qs;
      console.log(`  Groq returned 0 — trying heuristic`);
    } catch (e) {
      console.warn(`  Groq failed: ${e.message}`);
    }
  }

  console.log(`  using heuristic parser (free, local)…`);
  return parseHeuristic(extracted.fullText);
}

async function attachFigureImages(questions, extracted, pdfBuffer, documentId) {
  const pageHasImage = new Map();
  for (const p of extracted.pages || []) pageHasImage.set(p.pageNumber, Boolean(p.hasImage));

  const figurePages = new Set();
  for (const q of questions) {
    if (!Number.isInteger(q.pageNumber)) continue;
    if (q.hasFigure || pageHasImage.get(q.pageNumber)) figurePages.add(q.pageNumber);
  }
  if (figurePages.size === 0) return questions;

  const pageImageMap = {};
  try {
    const rendered = await renderPagesToPng(pdfBuffer, [...figurePages], 1.8, null);
    for (const [pageNumber, pngBuf] of rendered) {
      try {
        await savePageImage({ docId: documentId, pageNumber, buffer: pngBuf });
        pageImageMap[pageNumber] = `/api/documents/${documentId}/pages/${pageNumber}.png`;
      } catch (e) {
        console.warn(`  savePageImage p${pageNumber} failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`  page rendering failed: ${e.message}`);
  }

  return questions.map((q) => {
    const url = q.pageNumber ? pageImageMap[q.pageNumber] : null;
    return url ? { ...q, pageImageUrl: url } : q;
  });
}

async function processPdf(file) {
  const full = path.join(DIR, file);
  const buffer = fs.readFileSync(full);

  // Optional sidecar meta: <name>.meta.json
  const metaPath = full.replace(/\.pdf$/i, ".meta.json");
  let meta = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); }
    catch (e) { console.warn(`  bad meta.json (${e.message}) — ignoring`); }
  }

  console.log(`\n> ${file} — extracting text…`);
  const extracted = await extractPdfPages(buffer);
  console.log(`  pages=${extracted.pageCount}, textLength=${extracted.textLength}`);

  let questions;
  const cached = !FORCE && loadCache(file);
  if (cached && cached.length) {
    questions = cached;
    console.log(`  using cached parse (${questions.length} questions) — skip AI`);
  } else {
    console.log(`  parsing questions…`);
    const raw = await parseQuestions(buffer, extracted);
    questions = (raw || [])
      .map(normaliseQuestion)
      .filter((q) => q.text && q.options.some((o) => o));
    console.log(`  parsed ${questions.length} questions`);
    if (questions.length) saveCache(file, questions);
  }

  // Apply answer key if provided
  if (Array.isArray(meta.answers) && meta.answers.length) {
    let applied = 0;
    questions = questions.map((q, i) => {
      const idx = answerToIndex(meta.answers[i]);
      if (idx != null) { applied++; return { ...q, correctIndex: idx }; }
      return q;
    });
    console.log(`  applied answer key to ${applied}/${questions.length} questions`);
  }

  if (DRY || questions.length === 0) return { inserted: 0, count: questions.length };

  const documentId = newDocumentId();
  questions = await attachFigureImages(questions, extracted, buffer, documentId);
  const withImg = questions.filter((q) => q.pageImageUrl).length;
  if (withImg) console.log(`  saved diagram images for ${withImg} question(s)`);

  const pyp = {
    id: newId("pyp"),
    title: meta.title || file.replace(/\.pdf$/i, ""),
    examType: meta.examType || "NEET",
    year: Number(meta.year) || new Date().getFullYear(),
    subject: meta.subject || null,
    durationMinutes: Number(meta.durationMinutes) || 200,
    questions,
    createdAt: new Date().toISOString(),
  };

  await withRetry(() => storage.addPyp(pyp), { label: "addPyp" });
  console.log(`  ✓ inserted mock "${pyp.title}" with ${questions.length} questions`);
  return { inserted: 1, count: questions.length };
}

async function main() {
  if (!fs.existsSync(DIR)) { console.error(`[pyp-pdf] no dir ${DIR}`); process.exit(1); }
  const files = fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".pdf"))
    .filter((f) => !ONLY || f.toLowerCase().includes(ONLY));
  if (files.length === 0) {
    console.log(`[pyp-pdf] no PDFs found in ${DIR}. Drop your paper PDFs there. See README.md`);
    process.exit(0);
  }

  let papers = 0, total = 0;
  const imported = loadImported();
  for (const file of files) {
    if (!FORCE && imported.has(file)) { console.log(`= skip (already imported): ${file}`); continue; }
    try {
      const r = await processPdf(file);
      papers += r.inserted;
      total += r.count;
      if (r.inserted) { imported.add(file); saveImported(imported); }
    } catch (e) {
      console.warn(`[pyp-pdf] failed ${file}: ${(e?.message || e).toString().slice(0, 200)}`);
    }
  }
  console.log(`\n[pyp-pdf] done. mocks inserted=${papers}, questions parsed=${total}${DRY ? " (dry)" : ""}`);
  process.exit(0);
}

main().catch((e) => { console.error("[pyp-pdf] fatal:", e); process.exit(1); });
