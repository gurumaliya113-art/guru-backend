// Solution-sheet matcher.
//
// Many exam PDFs keep the answer key / detailed solutions in a block at the
// END of the paper, e.g.:
//
//   ANSWER KEY
//   1. (A)  2. (C)  3. (B)  4. (D) ...
//
// or detailed:
//
//   HINTS & SOLUTIONS
//   1. (A) Because the force acts ... hence option A.
//   2. (C) Using v = u + at ...
//
// This module locates that block, parses a { questionNumber -> answer/explanation }
// map, and attaches the answer + explanation back onto the parsed questions —
// matching solution #1 to question #1, #2 to #2, and so on.

const HEADING_RE =
  /(hints?\s*(?:&|and)?\s*solutions?|answer\s*key|answer\s*sheet|answers?|solutions?)/gi;

// "1. A" / "1) (B)" / "1 - c" / "12:D" — a question number followed by a single option letter/digit
const PAIR_RE = /(?:^|[\s,;|(])(\d{1,3})\s*[\.\)\-:]\s*\(?([A-Da-d1-4])\)?(?![\w])/g;

function letterToIndex(letter) {
  if (letter == null) return null;
  const c = String(letter).trim().toUpperCase();
  if (c >= "A" && c <= "D") return c.charCodeAt(0) - 65;
  const n = parseInt(c, 10);
  if (!isNaN(n) && n >= 1 && n <= 4) return n - 1;
  return null;
}

/**
 * Locate the answer/solutions region — the text AFTER the last solutions heading.
 * Returns null when no explicit heading is present (so we don't misread the
 * question paper itself as an answer key).
 */
function findSolutionsRegion(text) {
  let lastIdx = -1;
  let m;
  HEADING_RE.lastIndex = 0;
  while ((m = HEADING_RE.exec(text))) {
    // ignore a heading that appears too early (likely a per-question "Solution:")
    if (m.index > text.length * 0.3) lastIdx = m.index;
  }
  if (lastIdx < 0) return null;
  return text.slice(lastIdx);
}

/**
 * Parse an answer key + optional detailed explanations from the region.
 * @returns {Map<number, { answerIndex: number|null, explanation: string }>}
 */
export function extractAnswerKey(fullText) {
  const map = new Map();
  const text = (fullText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const region = findSolutionsRegion(text);
  if (!region) return map;

  // --- Pass 1: compact answer key ("1. A  2. B ...") ---
  let m;
  PAIR_RE.lastIndex = 0;
  while ((m = PAIR_RE.exec(region))) {
    const num = parseInt(m[1], 10);
    const idx = letterToIndex(m[2]);
    if (num >= 1 && num <= 500 && idx != null && !map.has(num)) {
      map.set(num, { answerIndex: idx, explanation: "" });
    }
  }

  // --- Pass 2: detailed solution blocks ("1. <text> ... 2. <text> ...") ---
  // Collect numbered markers at line starts and slice the text between them.
  const markerRe = /(?:^|\n)\s*(\d{1,3})\s*[\.\)]\s+/g;
  const markers = [];
  while ((m = markerRe.exec(region))) {
    markers.push({
      num: parseInt(m[1], 10),
      markerStart: m.index, // start of the whole "N." marker
      start: m.index + m[0].length, // start of the solution text
    });
  }
  for (let i = 0; i < markers.length; i++) {
    const { num, start } = markers[i];
    if (num < 1 || num > 500) continue;
    const end = i + 1 < markers.length ? markers[i + 1].markerStart : region.length;
    let block = region.slice(start, end).trim();
    if (!block) continue;
    // block may begin with the answer letter, e.g. "(A) Because ..."
    let answerIndex = null;
    const lead = block.match(/^\(?([A-Da-d1-4])\)?[\s\.\)\-:]/);
    if (lead) {
      answerIndex = letterToIndex(lead[1]);
    }
    // keep a reasonable explanation length
    const explanation = block.replace(/\s+/g, " ").slice(0, 1200).trim();
    const isMeaningful = explanation.length > 12; // more than just "(A)"
    const existing = map.get(num);
    if (existing) {
      if (existing.answerIndex == null && answerIndex != null) existing.answerIndex = answerIndex;
      if (!existing.explanation && isMeaningful) existing.explanation = explanation;
    } else {
      map.set(num, {
        answerIndex,
        explanation: isMeaningful ? explanation : "",
      });
    }
  }

  return map;
}

/**
 * Attach answers + explanations from the solution sheet onto the questions.
 * Matches by the question's own `number` when available, otherwise by its
 * sequential position (1st question -> solution #1, and so on).
 *
 * @param {Array} questions
 * @param {string} fullText
 * @returns {{ questions: Array, matched: number }}
 */
export function applySolutionSheet(questions, fullText) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return { questions: questions || [], matched: 0 };
  }
  const key = extractAnswerKey(fullText);
  if (key.size === 0) return { questions, matched: 0 };

  let matched = 0;
  const out = questions.map((q, i) => {
    const num = Number.isInteger(q.number) ? q.number : i + 1;
    const sol = key.get(num);
    if (!sol) return q;

    const next = { ...q };
    const optCount = Array.isArray(next.options) ? next.options.length : 0;
    let didMatch = false;

    if (sol.answerIndex != null && optCount > sol.answerIndex) {
      next.correctIndex = sol.answerIndex;
      didMatch = true;
    }
    if (sol.explanation && !String(next.explanation || "").trim()) {
      next.explanation = sol.explanation;
      didMatch = true;
    }
    if (didMatch) matched++;
    return next;
  });

  return { questions: out, matched };
}
