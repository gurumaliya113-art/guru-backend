// Gemini (Google AI Studio) question parser / answer helper.
// FREE tier: https://aistudio.google.com/app/apikey
// Default model: gemini-2.5-flash (stable, fast, reliable on the free tier).

import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";
import { normaliseCorrectIndex, extractInlineAnswer } from "./answer-key.js";

const newId = () => "q_" + crypto.randomBytes(4).toString("hex");

// Gemini sometimes wraps JSON in markdown fences (```json ... ```), adds a
// leading note, or emits a trailing comma — even when responseMimeType is set.
// This extractor strips fences/prose and pulls out the first balanced JSON
// object/array so a stray character no longer blows up the whole parse.
function extractJsonFromText(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // 1) direct parse (fast path)
  try {
    return JSON.parse(s);
  } catch {}

  // 2) strip markdown code fences ```json ... ``` or ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    try {
      return JSON.parse(inner);
    } catch {
      s = inner; // fall through with the fenced content
    }
  }

  // 3) slice from the first { or [ to the last matching } or ]
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  let start = -1;
  let closeChar = "}";
  if (firstObj === -1 && firstArr === -1) return null;
  if (firstArr === -1 || (firstObj !== -1 && firstObj < firstArr)) {
    start = firstObj;
    closeChar = "}";
  } else {
    start = firstArr;
    closeChar = "]";
  }
  const end = s.lastIndexOf(closeChar);
  if (start !== -1 && end !== -1 && end > start) {
    let candidate = s.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // 4) last resort: drop trailing commas before } or ]
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
      } catch {}
    }
  }
  return null;
}

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const DEFAULT_DPP_MODEL = process.env.GEMINI_DPP_MODEL || DEFAULT_MODEL;

// Stable, generally-available models. gemini-2.5-flash is fast + reliable;
// gemini-flash-latest is the fallback. We deliberately avoid preview models
// (e.g. gemini-3-*-preview) which frequently return 503 (overloaded).
const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-flash-latest"];

let preferredTextModel = null;
let preferredVisionModel = null;
let preferredChatModel = null;

// --- API key cooldown (automatic quota rotation) ---
// Give the server a POOL of Gemini keys via GEMINI_API_KEYS=key1,key2,...,key10
// When a key returns 429 (daily quota / rate limit exhausted) we "park" it on a
// cooldown so every later page and request skips it and goes straight to a
// working key. As each key's quota runs out it is parked and the next key takes
// over automatically — no manual swapping, and it keeps working day to day
// because the cooldown expires on its own (quota resets restore the key).
const keyCooldownUntil = new Map(); // apiKey -> epoch ms until which it's parked
// Most free-tier 429s are per-MINUTE rate limits that clear in ~60s (not daily
// quota). So we park a key for only ~60s — long enough to skip it during a
// burst, short enough that it rejoins the pool quickly instead of draining all
// keys after a few pages.
const KEY_COOLDOWN_MS = Number(process.env.GEMINI_KEY_COOLDOWN_MS || 60 * 1000);

// Human-readable label of the key that last succeeded, e.g. "Key 2 of 4".
// Surfaced to the UI so the teacher can see live which key is running and when
// it rotates to the next one.
let currentKeyLabel = null;

/** The Gemini key currently in use, e.g. "Key 2 of 4" (null if none used yet). */
export function getGeminiKeyLabel() {
  return currentKeyLabel;
}

function markKeyExhausted(apiKey) {
  keyCooldownUntil.set(apiKey, Date.now() + KEY_COOLDOWN_MS);
  console.warn(`[Gemini Parser] key ${String(apiKey).slice(0, 8)}… parked for ${Math.round(KEY_COOLDOWN_MS / 60000)}min (quota/429). Rotating to next key.`);
}

// Keys not currently parked. If EVERY key is parked, return all of them anyway —
// better to retry an exhausted key than to give up entirely.
function activeKeys(allKeys) {
  const now = Date.now();
  const active = allKeys.filter((k) => (keyCooldownUntil.get(k) || 0) <= now);
  return active.length ? active : allKeys;
}

const SYSTEM_PROMPT = `You are an expert at extracting multiple-choice questions from Indian competitive exam papers (NEET / JEE / Board).

Extract every question from the provided text. For each question return:
- text: the full question stem (clean, no "Q1." prefix)
- options: array of exactly 4 strings (A, B, C, D in order). If fewer are present, fill missing with empty strings.
- correctIndex: 0-based index of the correct option, taken ONLY from an answer key / marked answer / worked solution that is actually printed in the source. If the source does not state the answer, return null. NEVER guess, never solve the question yourself, and never default to 0 — a wrong answer is far worse than no answer.
- explanation: solution text if present in the source, else empty string.
- subject: one of "Physics" | "Chemistry" | "Biology" | "Mathematics" (best guess from content).
- topic: short topic name e.g. "Electrostatics", "Organic Chemistry", "Genetics". Empty if unsure.
- difficulty: "Easy" | "Moderate" | "Hard". Default "Moderate" if unsure.
- type: "MCQ" | "Assertion-Reason" | "Case-Based". Default "MCQ".
- examType: array containing one or more of "NEET", "JEE", "BOARD". Default ["NEET"].
- year: integer year if mentioned (e.g. PYQ 2022), else null.
- Do not paraphrase, simplify, or rewrite notation. Preserve what is written in the source as closely as possible.

ASSERTION-REASON questions (IMPORTANT — do NOT skip these): When a question is in the "Assertion (A) / Reason (R)" format, you MUST still extract it. Set type to "Assertion-Reason". Put BOTH statements in "text" on separate lines, e.g. "Assertion (A): <full assertion>\\nReason (R): <full reason>". Use the four options exactly as printed; if the paper does not print them, use the standard set: ["Both A and R are true and R is the correct explanation of A","Both A and R are true but R is NOT the correct explanation of A","A is true but R is false","A is false but R is true"]. Set correctIndex from the printed answer key only, else null.
- Preserve exact math notation. If you encounter corrupted fraction notation like '_{36}^x^2', 'x^2_36' or 'y^2_{16}' in the source, normalize it into correct LaTeX-style fraction form such as '\\frac{x^2}{36}' or '\\frac{y^2}{16}'.
Return ONLY valid JSON of the shape: { "questions": [...] }
No prose, no markdown fences.`;

export function isGeminiAvailable() {
  // Match the keys the parser actually uses (getGeminiApiKeys): primary,
  // secondary, and the comma-separated list. Checking only GEMINI_API_KEY made
  // the admin UI show "no key" even when a usable key was set in _2 / _KEYS.
  return !!(
    process.env.GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY_2 ||
    process.env.GEMINI_API_KEYS
  );
}

function buildModel({ modelName, systemInstruction, responseMimeType, apiKey }) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({
    model: modelName,
    systemInstruction,
    generationConfig: {
      ...(responseMimeType ? { responseMimeType } : {}),
      temperature: 0.2,
    },
  });
}

function getGeminiApiKeys() {
  const keys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    ...(process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(",") : []),
  ];

  return uniqueModels(keys.map((key) => key && key.trim()).filter(Boolean));
}

function uniqueModels(models) {
  const seen = new Set();
  return models.filter(Boolean).filter((modelName) => {
    if (seen.has(modelName)) return false;
    seen.add(modelName);
    return true;
  });
}

function getGeminiCandidates(primaryModel, preferredModel) {
  return uniqueModels([preferredModel, primaryModel, ...FALLBACK_MODELS]);
}

function isRetryableGeminiError(status) {
  return status === 429 || status === 404 || (status != null && status >= 500);
}

async function generateWithGeminiFallback({
  kind,
  primaryModel,
  payload,
  systemInstruction,
  responseMimeType,
}) {
  const preferredModel = kind === "vision"
    ? preferredVisionModel
    : kind === "chat"
    ? preferredChatModel
    : preferredTextModel;

  const candidates = getGeminiCandidates(primaryModel, preferredModel);
  const allKeys = getGeminiApiKeys();
  let lastError = null;
  // Track auth rejections separately. A 401/403 on EVERY key means the keys are
  // invalid/revoked (a leaked key auto-revoked by Google, or a stale value in
  // the host's env) — not a transient outage. That deserves a blunt message
  // instead of a generic "all fallback models failed", which sent admins
  // hunting through parser code for a problem that is purely credentials.
  let authFailures = 0;
  let attempts = 0;

  // Google's free tier frequently returns 503 "high demand". These spikes are
  // transient, so we retry the whole model/key sweep a few times with growing
  // backoff before giving up. This alone recovers most failed pages.
  const maxRounds = Number(process.env.GEMINI_RETRY_ROUNDS || 4);
  const backoffMs = [0, 2000, 5000, 12000];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Only sleep between rounds when we saw a TRANSIENT overload (503/5xx/404).
  // For pure 429 (quota) rounds we must NOT sleep — the key is already parked,
  // and sleeping would waste the per-page timeout and make that page fail while
  // rotating. Instead we retry the remaining active keys immediately.
  let backoffNext = false;

  for (let round = 0; round < maxRounds; round++) {
    if (round > 0 && backoffNext) {
      const wait = backoffMs[Math.min(round, backoffMs.length - 1)];
      console.warn(`[Gemini Parser] all models busy (overloaded) — backoff ${wait}ms then retry (round ${round + 1}/${maxRounds})`);
      await sleep(wait);
    }

    let sawRetryable = false;
    let sawOverload = false; // 503/5xx/404 — transient, worth a backoff
    // Recompute each round so keys whose cooldown just expired rejoin the pool.
    const apiKeys = activeKeys(allKeys);
    for (const modelName of candidates) {
      for (const apiKey of apiKeys) {
        const model = buildModel({ modelName, systemInstruction, responseMimeType, apiKey });
        attempts++;
        try {
          const result = await model.generateContent(payload);
          if (kind === "vision") preferredVisionModel = modelName;
          else if (kind === "chat") preferredChatModel = modelName;
          else preferredTextModel = modelName;
          // Record which key (position in the full pool) is now running.
          const poolIdx = allKeys.indexOf(apiKey);
          currentKeyLabel = poolIdx >= 0 ? `Key ${poolIdx + 1} of ${allKeys.length}` : null;
          return result;
        } catch (err) {
          const httpStatus = extractHttpStatus(err);
          lastError = err;
          if (httpStatus === 401 || httpStatus === 403) {
            authFailures++;
            console.warn(`[Gemini Parser] key ${String(apiKey).slice(0, 8)}… rejected with ${httpStatus} (invalid / revoked key)`);
            continue;
          }
          if (!isRetryableGeminiError(httpStatus)) {
            throw err;
          }
          sawRetryable = true;
          // 429 = this key's quota/rate is spent — park it so later pages skip
          // it, and rotate to the next key immediately (no backoff). Other
          // retryable errors (503/5xx/404) are transient overloads worth a wait.
          if (httpStatus === 429) markKeyExhausted(apiKey);
          else sawOverload = true;
          console.warn(`[Gemini Parser] key ${apiKey.slice(0, 8)}… model ${modelName} failed with ${httpStatus || "unknown"}; trying next key/model`);
        }
      }
    }
    backoffNext = sawOverload;
    // If nothing was retryable (e.g. all auth failures), don't keep looping.
    if (!sawRetryable) break;
  }

  // Every single attempt was rejected on authentication => the keys themselves
  // are the problem. Say so plainly, and mark it so callers can surface it.
  if (attempts > 0 && authFailures === attempts) {
    const err = new Error(
      `All ${allKeys.length} Gemini API key(s) were rejected (HTTP 401/403 — invalid or revoked). ` +
        `Generate a new key at https://aistudio.google.com/app/apikey and update GEMINI_API_KEY / GEMINI_API_KEYS ` +
        `in the server environment. Note: keys committed to a public repo are auto-revoked by Google.`
    );
    err.code = "GEMINI_AUTH_FAILED";
    throw err;
  }

  throw lastError || new Error("Gemini API error: all fallback models failed.");
}

/**
 * Extract HTTP status code from Gemini API error.
 * The SDK wraps errors with a status property.
 */
function extractHttpStatus(err) {
  // Check if error has status property (GoogleGenerativeAIFetchError)
  if (err?.status !== undefined && err.status !== null) {
    return err.status;
  }
  
  // Try parsing from error message
  const msg = err?.message || String(err);
  const statusMatch = msg.match(/\[(\d{3})/);
  return statusMatch ? parseInt(statusMatch[1], 10) : null;
}

export async function parseWithGemini(rawText, options = {}) {
  const geminiModel = options.modelName || DEFAULT_MODEL;
  const source = options.source || "pdf-ai";

  if (!isGeminiAvailable()) {
    throw new Error("No Gemini API key set (GEMINI_API_KEY / GEMINI_API_KEY_2) on the server.");
  }

  // Cap input size: 30k chars is safe for free tier
  const textSize = rawText?.length || 0;
  const maxChars = 30000;
  const text = (rawText || "").slice(0, maxChars);

  console.log(`[Gemini Parser] Input size: ${textSize} chars, capped to: ${text.length} chars`);

  console.log(`[Gemini Parser] Initializing with model: ${geminiModel}`);

  try {
    console.log(`[Gemini Parser] Sending request to ${geminiModel}...`);
    const result = await generateWithGeminiFallback({
      kind: "text",
      primaryModel: geminiModel,
      payload: text,
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
    });
    const raw = result.response.text();

    console.log(`[Gemini Parser] Response received (${raw.length} chars), parsing JSON...`);

    let parsed = extractJsonFromText(raw);
    if (parsed == null) {
      console.error(`[Gemini Parser] Failed to parse JSON response:`, String(raw).substring(0, 200));
      throw new Error("Gemini returned non-JSON. Try the heuristic parser instead.");
    }

    const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
    console.log(`[Gemini Parser] Successfully extracted ${list.length} questions`);
    return list.map((q) => normalise(q, { source }));
  } catch (err) {
    const httpStatus = extractHttpStatus(err);
    const errMsg = err?.message || String(err);

    console.error(`[Gemini Parser] Error detected:`);
    console.error(`  - HTTP Status: ${httpStatus || "unknown"}`);
    console.error(`  - Message: ${errMsg}`);
    console.error(`  - Full error:`, err);

    if (httpStatus === 401) {
      throw new Error("Gemini API authentication failed. Invalid or expired GEMINI_API_KEY in server/.env. Get a new key at https://aistudio.google.com/app/apikey");
    }

    if (httpStatus === 403) {
      throw new Error("Gemini API permission denied. Check if API is enabled in Google Cloud project. Use heuristic parser as fallback.");
    }

    if (httpStatus === 404) {
      throw new Error(`Gemini model "${geminiModel}" not found. Try: gemini-2.5-flash or gemini-flash-latest`);
    }

    if (httpStatus === 429) {
      throw new Error("Gemini API rate limit exceeded. I tried fallback Gemini models first; if this keeps happening, use heuristic parser or wait for quota reset.");
    }

    if (httpStatus && httpStatus >= 500) {
      throw new Error(`Gemini API server error (${httpStatus}). Try again in a moment or use heuristic parser.`);
    }

    throw new Error(`Gemini API error: ${errMsg || "unknown"}. Try the heuristic parser as fallback.`);
  }
}

const DPP_SYSTEM_PROMPT = `You are an expert at extracting questions from Indian exam papers (scanned images / PDF pages).

Read the attached page image and return structured JSON only.

For EACH question on the page return:
- number: the question's PRINTED number exactly as shown (integer). This is critical for matching answers later.
- text: full question stem, cleaned and preserved as written.
- options: array of exactly 4 strings in A/B/C/D order. If fewer are present, fill missing with empty strings.
- correctIndex: 0-based index of the correct option ONLY if the answer is actually marked / printed on THIS page (ticked, bold, circled, or given in a key or worked solution). Otherwise return null. NEVER solve the question yourself, never guess, and never default to 0 — leaving it null is correct and expected when the page does not show the answer.
- explanation: solution text if visible on this page, else empty string.
- subject: one of "Physics" | "Chemistry" | "Biology" | "Mathematics".
- topic: short chapter name.
- difficulty: "Easy" | "Moderate" | "Hard".
- type: "MCQ" | "Assertion-Reason" | "Case-Based".
- examType: array containing one or more of "NEET", "JEE", "BOARD".
- hasFigure: true if the question has/refers to a figure, diagram, graph, circuit, or image.
- figureBox: if hasFigure is true, the TIGHT bounding box of ONLY the figure graphics as normalized page coordinates [x0, y0, x1, y1] where each value is between 0 and 1 (0,0 = top-left, 1,1 = bottom-right). If there is no figure, return null.
  CRITICAL for figureBox tightness — the box must hug the diagram pixels only:
  * y0 (top edge) must start right at the top of the drawing, NOT on the question-stem text line above it. Leave the printed sentence above the figure OUTSIDE the box.
  * y1 (bottom edge) must end right at the bottom of the drawing, NOT on the next question/caption text line below it. Leave the sentence below the figure OUTSIDE the box.
  * Include axis labels and panel letters like (a)(b)(c)(d) that are part of the diagram, but do NOT include full sentences of body text.
  * When several option diagrams (a),(b),(c),(d) belong to one question, use ONE box that spans all the panels horizontally but stays tight top-and-bottom around just those drawings.

ASSERTION-REASON questions (IMPORTANT — do NOT skip these): When a question is in the "Assertion (A) / Reason (R)" format, you MUST still extract it. Set type to "Assertion-Reason". Put BOTH statements in "text" on separate lines, e.g. "Assertion (A): <full assertion>\\nReason (R): <full reason>". Use the four options exactly as printed; if not printed, use the standard set: ["Both A and R are true and R is the correct explanation of A","Both A and R are true but R is NOT the correct explanation of A","A is true but R is false","A is false but R is true"]. Set correctIndex from an answer key printed on the page only, else null.

ALSO, if this page contains an ANSWER KEY (e.g. "1. (c) 2. (b) ...") or a SOLUTIONS / EXPLANATIONS section, return them in an "answers" array. For each answer return:
- number: the question number (integer).
- correctIndex: 0-based index (A=0, B=1, C=2, D=3) of the correct option, if given.
- explanation: the solution / explanation text for that number, if given, else empty string.

Preserve math notation exactly. Return ONLY valid JSON with shape:
{ "questions": [...], "answers": [...] }
Use an empty array when a section is absent. No prose, no markdown fences.`;

export async function parseWithGeminiVision({ imageBuffer, mimeType, modelName, pageNumber, source = "dpp-ai" }) {
  if (!isGeminiAvailable()) {
    throw new Error("No Gemini API key set (GEMINI_API_KEY / GEMINI_API_KEY_2) on the server.");
  }

  const geminiModel = modelName || DEFAULT_DPP_MODEL;
  const part = {
    inlineData: {
      data: Buffer.isBuffer(imageBuffer) ? imageBuffer.toString("base64") : Buffer.from(imageBuffer).toString("base64"),
      mimeType: mimeType || "image/png",
    },
  };

  const prompt = pageNumber
    ? `Extract all questions, figure boxes, and any answer key / solutions from page ${pageNumber}.`
    : "Extract all questions, figure boxes, and any answer key / solutions from the attached image.";
  const result = await generateWithGeminiFallback({
    kind: "vision",
    primaryModel: geminiModel,
    payload: [prompt, part],
    systemInstruction: DPP_SYSTEM_PROMPT,
    responseMimeType: "application/json",
  });
  const raw = result.response.text();
  let parsed = extractJsonFromText(raw);
  if (parsed == null) {
    console.error(`[Gemini Vision] Failed to parse JSON response:`, String(raw).substring(0, 300));
    throw new Error("Gemini returned non-JSON while parsing image input.");
  }

  const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const answers = Array.isArray(parsed?.answers)
    ? parsed.answers
        .map((a) => ({
          number: Number.isInteger(a?.number) ? a.number : parseInt(a?.number, 10) || null,
          // Accepts 0..3, "2", "B", "(b)", "Option C" — null when unusable.
          correctIndex: normaliseCorrectIndex(a?.correctIndex),
          explanation: String(a?.explanation || "").trim(),
        }))
        .filter((a) => a.number != null)
    : [];

  return {
    questions: list.map((q) => normalise(q, { source, pageNumber })),
    answers,
  };
}

const ANSWER_SYSTEM_PROMPT = `You are a real-time study assistant for DPP practice questions.
Explain the answer clearly, step by step, in concise language.
If the user asks about a specific question, solve it directly.
If the user asks for a hint, provide a brief hint instead of the full solution.
Keep answers focused and exam-oriented.`;

export async function answerWithGemini({ message, conversationHistory = [], modelName, systemInstruction = ANSWER_SYSTEM_PROMPT }) {
  if (!isGeminiAvailable()) {
    throw new Error("No Gemini API key set (GEMINI_API_KEY / GEMINI_API_KEY_2) on the server.");
  }

  const geminiModel = modelName || DEFAULT_DPP_MODEL;
  const messages = [
    ...conversationHistory.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    })),
    { role: "user", parts: [{ text: message }] },
  ];

  const result = await generateWithGeminiFallback({
    kind: "chat",
    primaryModel: geminiModel,
    payload: { contents: messages },
    systemInstruction,
  });
  return result.response.text() || "Sorry, I couldn't generate a response.";
}

function normalise(q, extras = {}) {
  const options = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
  while (options.length < 4) options.push("");

  // The answer comes from the model's key ONLY, or from a trailing "Ans: (C)"
  // still sitting in the stem. If neither exists it stays null.
  const modelIndex = normaliseCorrectIndex(q.correctIndex);
  const rawText = String(q.text || "").trim();
  const inline = modelIndex == null ? extractInlineAnswer(rawText) : null;

  const allowedSubjects = ["Physics", "Chemistry", "Biology", "Mathematics"];
  const allowedDifficulty = ["Easy", "Moderate", "Hard"];
  const allowedType = ["MCQ", "Assertion-Reason", "Case-Based"];
  const allowedExam = ["NEET", "JEE", "BOARD"];

  const examType = Array.isArray(q.examType)
    ? q.examType.filter((e) => allowedExam.includes(e))
    : [];

  return {
    id: newId(),
    text: inline ? inline.cleanedText : rawText,
    options: options.map((o) => String(o || "").trim()),
    // null when the source never stated the answer. Never 0 — see answer-key.js.
    correctIndex: modelIndex != null ? modelIndex : inline ? inline.index : null,
    explanation: String(q.explanation || "").trim(),
    subject: allowedSubjects.includes(q.subject) ? q.subject : "Physics",
    topic: String(q.topic || "").trim(),
    difficulty: allowedDifficulty.includes(q.difficulty) ? q.difficulty : "Moderate",
    type: allowedType.includes(q.type) ? q.type : "MCQ",
    examType: examType.length ? examType : ["NEET"],
    year: Number.isInteger(q.year) ? q.year : undefined,
    number: Number.isInteger(q.number) ? q.number : (parseInt(q.number, 10) || undefined),
    pageNumber: Number.isInteger(extras.pageNumber) ? extras.pageNumber : (Number.isInteger(q.pageNumber) ? q.pageNumber : undefined),
    hasFigure: typeof q.hasFigure === "boolean" ? q.hasFigure : false,
    figureBox: normaliseBox(q.figureBox),
    source: extras.source || "pdf-ai",
  };
}

/** Validate a normalized [x0,y0,x1,y1] box (each 0..1, x0<x1, y0<y1). */
function normaliseBox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const nums = box.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  let [x0, y0, x1, y1] = nums;
  // clamp
  x0 = Math.max(0, Math.min(1, x0));
  y0 = Math.max(0, Math.min(1, y0));
  x1 = Math.max(0, Math.min(1, x1));
  y1 = Math.max(0, Math.min(1, y1));
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}
