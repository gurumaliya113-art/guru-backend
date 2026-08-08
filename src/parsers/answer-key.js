// Answer-key normalisation — the single source of truth for "which option is correct".
//
// HARD RULE: no answer key => no answer.
// Every function here returns `null` when the correct option is genuinely
// unknown. Nothing in this module ever falls back to 0 / "A". Defaulting to 0
// silently marked option A correct on every question whose key was missing,
// which is the bug this module exists to prevent.
//
// Accepted spellings for a key (all map to the same index):
//   "A" "a" "(B)" "B)" "[C]" "D." "Ans: B" "Answer - C" "Correct Answer: Option D"
//   "Option B" "opt c" "1" "2" "3" "4"  (1-based digits)

/** Longest-first so "correct answer" is consumed before "answer". */
const LABEL_RE =
  /^\s*(?:correct\s*(?:answer|option|ans)|answer\s*key|answer|ans|option|opt|sol(?:ution)?)\s*(?:is)?\s*[:\-–—.=)]*\s*/i;

/**
 * Convert a single answer token into a 0-based option index.
 * @param {unknown} value
 * @returns {number|null} 0..3, or null when unknown / unparseable.
 */
export function letterToIndex(value) {
  if (value == null) return null;

  // A real number is treated as an index only if it is already 0..3.
  // Numeric strings are handled below as 1-based, matching how papers print keys.
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  }

  let s = String(value).trim();
  if (!s) return null;

  // Strip leading labels repeatedly — real keys stack them, e.g.
  // "Correct Answer: Option C" needs both "Correct Answer:" and "Option" gone.
  for (let i = 0; i < 3; i++) {
    const stripped = s.replace(LABEL_RE, "").trim();
    if (stripped === s) break;
    s = stripped;
  }
  if (!s) return null;

  // Unwrap brackets/punctuation around the token: "(B)." -> "B"
  s = s.replace(/^[\(\[\{<"'`]+/, "").replace(/[\)\]\}>"'`.,;:]+$/, "").trim();
  if (!s) return null;

  // A single letter A-D (either case).
  if (/^[A-Da-d]$/.test(s)) return s.toUpperCase().charCodeAt(0) - 65;

  // A single digit 1-4, printed 1-based in answer keys.
  if (/^[1-4]$/.test(s)) return parseInt(s, 10) - 1;

  return null;
}

/**
 * Normalise a model/parser-supplied `correctIndex`.
 * Returns null unless it is genuinely an integer in 0..3.
 * @returns {number|null}
 */
export function normaliseCorrectIndex(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  }
  // Models sometimes emit "2", "B", or "Option C" in this field.
  if (typeof value === "string") {
    const t = value.trim();
    if (/^[0-3]$/.test(t)) return parseInt(t, 10);
    return letterToIndex(t);
  }
  return null;
}

/**
 * Find an answer key inline in a question's own text, e.g. a trailing
 * "Ans: (C)" or "Correct Answer - B" line. Returns null when absent.
 * Only matches when the key is on its own line / at the very end, so option
 * text like "Answer is 5 m/s" is never mistaken for a key.
 * @param {string} text
 * @returns {{ index: number, cleanedText: string }|null}
 */
export function extractInlineAnswer(text) {
  const src = String(text || "");
  if (!src.trim()) return null;

  const re =
    /(?:^|\n)\s*(?:correct\s*(?:answer|option|ans)|answer\s*key|answer|ans)\s*[:\-–—.=]?\s*\(?\s*(?:option\s*)?([A-Da-d1-4])\s*\)?\s*\.?\s*$/i;
  const m = src.match(re);
  if (!m) return null;

  const index = letterToIndex(m[1]);
  if (index == null) return null;

  return { index, cleanedText: src.slice(0, m.index).trimEnd() };
}

/**
 * Guard used right before persisting a question: keep a valid index, otherwise
 * null. `optionCount` (when given) rejects an index pointing at an option that
 * does not exist, e.g. answer "D" on a 2-option question.
 * @returns {number|null}
 */
export function safeCorrectIndex(value, optionCount = 4) {
  const idx = normaliseCorrectIndex(value);
  if (idx == null) return null;
  const count = Number.isInteger(optionCount) ? optionCount : 4;
  return idx < count ? idx : null;
}
