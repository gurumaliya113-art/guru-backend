// Gemini (Google AI Studio) PDF text → structured questions parser.
// FREE tier: https://aistudio.google.com/app/apikey
// Model: gemini-2.0-flash — latest model, fast, supports JSON mode, UTF-8 Hindi text support.

import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";

const newId = () => "q_" + crypto.randomBytes(4).toString("hex");

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

Return ONLY valid JSON of the shape: { "questions": [...] }
No prose, no markdown fences.`;

export function isGeminiAvailable() {
  return !!process.env.GEMINI_API_KEY;
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

export async function parseWithGemini(rawText) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not set in server/.env");
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const geminiModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";

  console.log(`[Gemini Parser] Initializing with model: ${geminiModel}`);
  console.log(`[Gemini Parser] API key present: ${apiKey ? "yes (" + apiKey.length + " chars)" : "no"}`);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: geminiModel,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

  // Cap input size: 30k chars is safe for free tier
  const textSize = rawText?.length || 0;
  const maxChars = 30000;
  const text = (rawText || "").slice(0, maxChars);

  console.log(`[Gemini Parser] Input size: ${textSize} chars, capped to: ${text.length} chars`);

  try {
    console.log(`[Gemini Parser] Sending request to ${geminiModel}...`);
    const result = await model.generateContent(text);
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
    return list.map((q) => normalise(q));
  } catch (err) {
    const httpStatus = extractHttpStatus(err);
    const errMsg = err?.message || String(err);

    console.error(`[Gemini Parser] Error detected:`);
    console.error(`  - HTTP Status: ${httpStatus || "unknown"}`);
    console.error(`  - Message: ${errMsg}`);
    console.error(`  - Full error:`, err);

    // 401: Invalid or expired API key
    if (httpStatus === 401) {
      throw new Error("Gemini API authentication failed. Invalid or expired GEMINI_API_KEY in server/.env. Get a new key at https://aistudio.google.com/app/apikey");
    }

    // 403: Permission/quota issue (not rate limit)
    if (httpStatus === 403) {
      throw new Error("Gemini API permission denied. Check if API is enabled in Google Cloud project. Use heuristic parser as fallback.");
    }

    // 404: Model not found
    if (httpStatus === 404) {
      throw new Error(`Gemini model "${geminiModel}" not found. Try: gemini-2.0-flash, gemini-1.5-pro, or gemini-1.5-flash`);
    }

    // 429: Actual rate limit (only retry for this)
    if (httpStatus === 429) {
      throw new Error("Gemini API rate limit exceeded. Free tier quota exhausted. Use heuristic parser or wait 24 hours for quota reset.");
    }

    // 500+: Server error (retriable)
    if (httpStatus && httpStatus >= 500) {
      throw new Error(`Gemini API server error (${httpStatus}). Try again in a moment or use heuristic parser.`);
    }

    // Generic error: don't assume rate limit
    throw new Error(`Gemini API error: ${errMsg || "unknown"}. Try the heuristic parser as fallback.`);
  }
}

function normalise(q) {
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
    source: "pdf-ai",
  };
}
