// Gemini (Google AI Studio) question parser / answer helper.
// FREE tier: https://aistudio.google.com/app/apikey
// Default model: gemini-3-flash-preview to match the active AI Studio model.

import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";

const newId = () => "q_" + crypto.randomBytes(4).toString("hex");

const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const DEFAULT_DPP_MODEL = process.env.GEMINI_DPP_MODEL || DEFAULT_MODEL;

const FALLBACK_MODELS = ["gemini-3-flash-preview", "gemini-2.0-flash"];

let preferredTextModel = null;
let preferredVisionModel = null;
let preferredChatModel = null;

const SYSTEM_PROMPT = `You are an expert at extracting multiple-choice questions from Indian competitive exam papers (NEET / JEE / Board).

Extract every question from the provided text. For each question return:
- text: the full question stem (clean, no "Q1." prefix)
- options: array of exactly 4 strings (A, B, C, D in order). If fewer are present, fill missing with empty strings.
- correctIndex: 0-based index of the correct option. If unknown, return 0.
- explanation: solution text if present in the source, else empty string.
- subject: one of "Physics" | "Chemistry" | "Biology" | "Mathematics" (best guess from content).
- topic: short topic name e.g. "Electrostatics", "Organic Chemistry", "Genetics". Empty if unsure.
- difficulty: "Easy" | "Moderate" | "Hard". Default "Moderate" if unsure.
- type: "MCQ" | "Assertion-Reason" | "Case-Based". Default "MCQ".
- examType: array containing one or more of "NEET", "JEE", "BOARD". Default ["NEET"].
- year: integer year if mentioned (e.g. PYQ 2022), else null.
- Do not paraphrase, simplify, or rewrite notation. Preserve what is written in the source as closely as possible.
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
  const apiKeys = getGeminiApiKeys();
  let lastError = null;

  for (const modelName of candidates) {
    for (const apiKey of apiKeys) {
      const model = buildModel({ modelName, systemInstruction, responseMimeType, apiKey });

      try {
        const result = await model.generateContent(payload);
        if (kind === "vision") preferredVisionModel = modelName;
        else if (kind === "chat") preferredChatModel = modelName;
        else preferredTextModel = modelName;
        return result;
      } catch (err) {
        const httpStatus = extractHttpStatus(err);
        if (httpStatus === 401 || httpStatus === 403) {
          lastError = err;
          continue;
        }

        lastError = err;
        if (!isRetryableGeminiError(httpStatus)) {
          throw err;
        }

        console.warn(`[Gemini Parser] key ${apiKey.slice(0, 8)}… model ${modelName} failed with ${httpStatus || "unknown"}; trying next key/model`);
      }
    }
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

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`[Gemini Parser] Failed to parse JSON response:`, raw.substring(0, 200));
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
      throw new Error(`Gemini model "${geminiModel}" not found. Try: gemini-3-flash-preview or gemini-2.0-flash`);
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

const DPP_SYSTEM_PROMPT = `You are an expert at extracting DPP-style practice questions from Indian exam material.

Extract every question visible in the attached page or image. Return structured JSON only.

For each question return:
- text: full question stem, cleaned and preserved as written
- options: array of exactly 4 strings in A/B/C/D order. If fewer are present, fill missing with empty strings.
- correctIndex: 0-based index of the correct option. If unknown, return 0.
- explanation: answer or solution text if visible, else empty string.
- subject: one of "Physics" | "Chemistry" | "Biology" | "Mathematics".
- topic: short chapter name.
- difficulty: "Easy" | "Moderate" | "Hard".
- type: "MCQ" | "Assertion-Reason" | "Case-Based".
- examType: array containing one or more of "NEET", "JEE", "BOARD".
- pageNumber: page number supplied by the caller, if any.
- hasFigure: true if the question references a figure, diagram, graph, circuit, or image.

Preserve math notation exactly. Return ONLY valid JSON with shape { "questions": [...] }.`;

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

  const prompt = pageNumber ? `Extract all questions from page ${pageNumber}.` : "Extract all questions from the attached image.";
  const result = await generateWithGeminiFallback({
    kind: "vision",
    primaryModel: geminiModel,
    payload: [prompt, part],
    systemInstruction: DPP_SYSTEM_PROMPT,
    responseMimeType: "application/json",
  });
  const raw = result.response.text();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("Gemini returned non-JSON while parsing image input.");
  }

  const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
  return list.map((q) => normalise(q, { source, pageNumber }));
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

  const allowedSubjects = ["Physics", "Chemistry", "Biology", "Mathematics"];
  const allowedDifficulty = ["Easy", "Moderate", "Hard"];
  const allowedType = ["MCQ", "Assertion-Reason", "Case-Based"];
  const allowedExam = ["NEET", "JEE", "BOARD"];

  const examType = Array.isArray(q.examType)
    ? q.examType.filter((e) => allowedExam.includes(e))
    : [];

  return {
    id: newId(),
    text: String(q.text || "").trim(),
    options: options.map((o) => String(o || "").trim()),
    correctIndex: Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3
      ? q.correctIndex
      : 0,
    explanation: String(q.explanation || "").trim(),
    subject: allowedSubjects.includes(q.subject) ? q.subject : "Physics",
    topic: String(q.topic || "").trim(),
    difficulty: allowedDifficulty.includes(q.difficulty) ? q.difficulty : "Moderate",
    type: allowedType.includes(q.type) ? q.type : "MCQ",
    examType: examType.length ? examType : ["NEET"],
    year: Number.isInteger(q.year) ? q.year : undefined,
    pageNumber: Number.isInteger(extras.pageNumber) ? extras.pageNumber : (Number.isInteger(q.pageNumber) ? q.pageNumber : undefined),
    hasFigure: typeof q.hasFigure === "boolean" ? q.hasFigure : false,
    source: extras.source || "pdf-ai",
  };
}
