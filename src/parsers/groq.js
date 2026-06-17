// Groq (Llama 3.3) parser — FREE tier, 30 req/min, way better quality than Gemini for our use case.
// Get a key: https://console.groq.com/keys (no credit card needed)
//
// Strategy:
//   1. Take raw text from pdf-parse
//   2. Chunk to ~6000 chars (safe for free tier context)
//   3. Ask Llama 3.3 70B to return strict JSON of questions
//   4. Merge + normalise
//
// Falls back gracefully — caller decides what to do on error.

import Groq from "groq-sdk";
import crypto from "crypto";

const newId = () => "q_" + crypto.randomBytes(4).toString("hex");

const SYSTEM_PROMPT = `You extract multiple-choice questions from Indian competitive exam papers (NEET / JEE / CBSE Board / State Boards).

CRITICAL — PRESERVE EVERY SYMBOL EXACTLY:
- Do NOT delete or simplify any variable, subscript, superscript, label, or math symbol.
- If the source says "L₁", "L_1", "L1", "f", "AB plane", "XY", you MUST keep them in your output verbatim.
- Convert Unicode subscripts/superscripts to LaTeX-style underscores when natural:
   "L₁" -> "L_1",  "x²" -> "x^2",  "H₂O" -> "H_2O",  "λ" -> "λ"  (keep Greek letters as-is).
- Keep math expressions, equations, units (m/s, μC, Ω) and Greek letters intact.
- Do not paraphrase, simplify, or rewrite notation. Preserve what is written in the source as closely as possible.
- When a denominator is written with a misplaced underscore or superscript, preserve the correct mathematical intent using LaTeX fraction form. For example, interpret '_{36}^x^2' or 'x^2_36' as '\\frac{x^2}{36}'.
- Keep references like "as shown in figure", "in the diagram above" intact in the question text.

The user's text contains markers "===== PAGE N =====" indicating page boundaries.
Each question is on a specific page; use that to fill the "pageNumber" field.

For EVERY question in the user's text, return one object with these fields:
- text: full question stem, cleaned (no "Q1." / "1)" / "Question 1." prefixes). Keep ALL math, subscripts, labels.
- options: array of EXACTLY 4 strings in order A, B, C, D. If fewer present, fill missing with "".
- correctIndex: 0-based index of correct option. If unknown, use 0.
- explanation: solution / answer key text if present, else "".
- subject: one of "Physics" | "Chemistry" | "Biology" | "Mathematics" (best guess).
- topic: short topic e.g. "Ray Optics", "Organic Chemistry", "Genetics". "" if unsure.
- difficulty: "Easy" | "Moderate" | "Hard". Default "Moderate".
- type: "MCQ" | "Assertion-Reason" | "Numerical" | "Case-Based". Default "MCQ".
- examType: array with one or more of "NEET", "JEE", "BOARD". Default ["JEE"].
- year: integer year if mentioned else null.
- pageNumber: integer page number where this question appears (from the PAGE markers in the text).
- hasFigure: boolean. true if the question references a figure/diagram/image (phrases like "shown in figure", "in the diagram", "given graph", "circuit shown", or the page is marked "[contains image]"). false otherwise.

Return ONLY valid JSON of shape: {"questions": [...]}
No prose, no markdown fences, no comments. If text has no questions, return {"questions": []}.`;

export function isGroqAvailable() {
  return !!process.env.GROQ_API_KEY;
}

// Chunk on PAGE boundaries so each chunk always carries its "===== PAGE N =====" header.
// Falls back to line splitting only if a single page is huge.
//
// IMPORTANT — keep `size` small enough to fit under Groq's per-minute token limit (TPM):
//   llama-3.1-8b-instant: TPM = 6000  → keep each request well under ~4500 tokens
//   llama-3.3-70b-versatile: TPM ≈ 30000 → can take bigger
// Roughly 1 token ≈ 4 chars, so 2500 chars ≈ 625 tokens for the chunk itself.
// Plus the ~600-token system prompt, total request ≈ 1300 tokens. Safe everywhere.
function chunkText(text, size = 2500) {
  const chunks = [];
  const pageRegex = /(?=^={5,}\s*PAGE\s+\d+)/m;
  const segments = text.split(pageRegex).filter((s) => s.trim());

  let buf = "";
  for (const seg of segments) {
    if (seg.length > size) {
      // single page is too big — flush current buf, then split that page by lines
      if (buf.trim()) { chunks.push(buf); buf = ""; }
      const lines = seg.split("\n");
      let sub = "";
      for (const line of lines) {
        if (sub.length + line.length + 1 > size && sub.length > 0) {
          chunks.push(sub);
          sub = "";
        }
        sub += line + "\n";
      }
      if (sub.trim()) chunks.push(sub);
      continue;
    }
    if (buf.length + seg.length > size && buf.length > 0) {
      chunks.push(buf);
      buf = "";
    }
    buf += seg;
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

export async function parseWithGroq(rawText) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set in backend/.env. Get free key at https://console.groq.com/keys");
  }

  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const primaryModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const fallbackModel = process.env.GROQ_FALLBACK_MODEL || "llama-3.1-8b-instant";

  const text = (rawText || "").trim();
  if (!text) return [];

  // Smaller chunks fit safely under the 8B model's 6000 TPM limit.
  // The 70B model has 30K TPM so this is no problem there either.
  const chunks = chunkText(text, 2500);
  console.log(`[Groq Parser] model=${primaryModel}, text=${text.length} chars, chunks=${chunks.length}`);

  // If the primary model returns a 429 (daily/min limit), switch to the smaller model
  // for the remaining chunks. The 8B model has ~10× the daily token quota on the free tier.
  let currentModel = primaryModel;
  let switchedToFallback = false;

  const callOne = async (chunk, modelToUse) => {
    const resp = await client.chat.completions.create({
      model: modelToUse,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: chunk },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 4096,
    });
    return resp.choices?.[0]?.message?.content || "{}";
  };

  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`[Groq Parser] chunk ${i + 1}/${chunks.length} (${chunk.length} chars) using ${currentModel}...`);
    let raw;
    try {
      raw = await callOne(chunk, currentModel);
    } catch (err) {
      const msg = err?.message || String(err);
      const is429 = msg.includes("429") || /rate.?limit/i.test(msg);
      console.error(`[Groq Parser] chunk ${i + 1} error: ${msg.slice(0, 200)}`);
      if (is429 && !switchedToFallback && currentModel !== fallbackModel) {
        console.warn(`[Groq Parser] 429 hit — switching to ${fallbackModel} and retrying chunk ${i + 1}`);
        currentModel = fallbackModel;
        switchedToFallback = true;
        try {
          raw = await callOne(chunk, currentModel);
        } catch (err2) {
          console.error(`[Groq Parser] chunk ${i + 1} also failed on fallback: ${(err2?.message || err2).slice(0, 200)}`);
          continue;
        }
      } else if (is429) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      } else {
        continue;
      }
    }

    let parsed;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
      console.warn(
        `[Groq Parser] chunk ${i + 1} returned non-JSON, skipping. raw=${
          typeof raw === "string" ? raw.slice(0, 1000) : JSON.stringify(raw)
        }`,
        err,
      );
      continue;
    }
    const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
    console.log(`[Groq Parser] chunk ${i + 1} -> ${list.length} questions`);
    for (const q of list) all.push(normalise(q));
  }

  // De-duplicate by question text (Groq sometimes echoes a question across chunks)
  const seen = new Set();
  const deduped = [];
  for (const q of all) {
    const key = q.text.trim().slice(0, 120).toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      deduped.push(q);
    }
  }
  console.log(`[Groq Parser] total ${all.length} -> deduped ${deduped.length}`);
  return deduped;
}

function normalise(q, pageImageBounds = null) {
  const allowedSubjects = ["Physics", "Chemistry", "Biology", "Mathematics"];
  const allowedDifficulty = ["Easy", "Moderate", "Hard"];
  const allowedType = ["MCQ", "Assertion-Reason", "Numerical", "Case-Based"];
  const allowedExam = ["NEET", "JEE", "BOARD"];

  const options = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
  while (options.length < 4) options.push("");

  const examType = Array.isArray(q.examType)
    ? q.examType.filter((e) => allowedExam.includes(e))
    : [];

  // Heuristic figure detection as a safety net (Llama sometimes forgets the flag)
  const text = String(q.text || "").trim();
  const figureRe = /(shown in (the )?(figure|diagram|graph)|in the (figure|diagram|graph)|as shown|circuit (above|below|shown)|given (figure|diagram|graph)|adjoining figure|following figure)/i;
  const detectedFigure = figureRe.test(text);

  return {
    id: newId(),
    text,
    options: options.map((o) => String(o || "").trim()),
    correctIndex:
      Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3
        ? q.correctIndex
        : 0,
    explanation: String(q.explanation || "").trim(),
    subject: allowedSubjects.includes(q.subject) ? q.subject : "Physics",
    topic: String(q.topic || "").trim(),
    difficulty: allowedDifficulty.includes(q.difficulty) ? q.difficulty : "Moderate",
    type: allowedType.includes(q.type) ? q.type : "MCQ",
    examType: examType.length ? examType : ["JEE"],
    year: Number.isInteger(q.year) ? q.year : undefined,
    pageNumber: Number.isInteger(q.pageNumber) && q.pageNumber > 0 ? q.pageNumber : null,
    hasFigure: typeof q.hasFigure === "boolean" ? q.hasFigure : detectedFigure,
    // Attach extracted image bounds (if available) for precise cropping later
    figureBounds: (detectedFigure || q.hasFigure) && pageImageBounds ? pageImageBounds : null,
    source: "pdf-groq",
  };
}
