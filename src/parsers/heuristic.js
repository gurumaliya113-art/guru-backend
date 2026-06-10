// Heuristic PDF → questions parser.
// Works on plain text. No external API needed.
//
// Recognises common Indian exam paper formats, e.g.:
//   Q1. or 1. or 1) — question number
//   (A) ... (B) ... (C) ... (D) — options (also "A." "A)" "(a)")
//   Answer: A  /  Ans: (B)  /  Correct option: 3
//
// Quality is best-effort — admin should always review on the next screen.

import crypto from "crypto";

const QUESTION_START_RE = /^\s*(?:Q(?:uestion)?\s*)?(\d{1,3})\s*[\.\)\:]\s*(.+)$/i;
const OPTION_RE = /^\s*(?:\(?([A-Da-d1-4])\)?(?:[\.\)\:\-])?\s*)(.*)$/;
const ANSWER_RE = /^\s*(?:Answer|Ans|Answer\s*key|Correct\s*(?:answer|option|ans)|Solution)\s*[:\-]?\s*(?:is\s*)?\(?([A-Da-d1-4])\)?/i;
const ANSWER_NUMERIC_RE = /^\s*(?:Answer|Ans|Answer\s*key|Correct\s*(?:answer|option|ans)|Solution)\s*[:\-]?\s*(?:is\s*)?\(?([1-4])\)?/i;
const ANSWER_ONLY_RE = /^\s*\(?([A-Da-d1-4])\)?\s*$/i;
const ANSWER_NUMERIC_ONLY_RE = /^\s*\(?([1-4])\)?\s*$/;
const EXPLANATION_RE = /^\s*(?:Explanation|Solution|Sol|Reason)\s*[:\-]\s*(.+)$/i;
const INLINE_OPTION_SPLIT_RE = /(?:^|\s)([A-Da-d1-4])(?:[\.\)\:\-])?\s+/g;

function letterToIndex(letter) {
  if (!letter) return null;
  const c = letter.toString().trim().toUpperCase();
  if (c >= "A" && c <= "D") return c.charCodeAt(0) - 65;
  const n = parseInt(c, 10);
  if (!isNaN(n) && n >= 1 && n <= 4) return n - 1;
  return null;
}

function newId() {
  return "q_" + crypto.randomBytes(4).toString("hex");
}

export function parseHeuristic(rawText) {
  const text = (rawText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u00a0\u200b\u00ad]/g, " ")
    .replace(/[ ]{2,}/g, " ");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const questions = [];
  let cur = null;
  let pendingExplanation = "";

  const push = () => {
    if (!cur) return;
    const opts = (cur.options || []).filter((o) => o && o.trim());
    if (cur.text && opts.length >= 2) {
      questions.push({
        id: newId(),
        subject: "Physics",
        topic: "",
        text: cur.text.trim(),
        options: opts,
        correctIndex: cur.correctIndex != null ? cur.correctIndex : 0,
        explanation: (cur.explanation || pendingExplanation || "").trim(),
        difficulty: "Moderate",
        type: "MCQ",
        examType: ["NEET"],
        source: "pdf",
      });
    }
    cur = null;
    pendingExplanation = "";
  };

  const splitInlineOptions = (line) => {
    if (QUESTION_START_RE.test(line)) {
      return [line];
    }

    const normalizedLine = line
      .replace(/([A-Da-d1-4])([\.\)\:\-])(?=\S)/g, "$1$2 ")
      .replace(/(?:^|\s)([A-Da-d1-4])\s+(?=[A-Za-z0-9])/g, " $1 ");

    const segments = [];
    let lastIndex = 0;
    let regex = /(?:^|\s)([A-Da-d1-4])(?:[\.\)\:\-])?\s+/g;
    let match = regex.exec(normalizedLine);

    if (!match) {
      regex = /(?:^|\s)([A-Da-d1-4])\s+(?=[A-Za-z0-9])/g;
      match = regex.exec(normalizedLine);
    }

    while (match) {
      const markerIndex = match.index + (normalizedLine[match.index] === " " ? 1 : 0);
      if (markerIndex > lastIndex) {
        segments.push(normalizedLine.slice(lastIndex, markerIndex).trim());
      }
      lastIndex = markerIndex;
      match = regex.exec(normalizedLine);
    }

    if (lastIndex < normalizedLine.length) {
      segments.push(normalizedLine.slice(lastIndex).trim());
    }

    return segments.length > 1 ? segments : [line];
  };

  const processChunk = (chunk) => {
    const qMatch = chunk.match(QUESTION_START_RE);
    const optMatch = chunk.match(OPTION_RE);
    const ansMatch = chunk.match(ANSWER_RE);
    const numAnsMatch = chunk.match(ANSWER_NUMERIC_RE);
    const expMatch = chunk.match(EXPLANATION_RE);

    if (qMatch) {
      push();
      cur = { text: qMatch[2].trim(), options: ["", "", "", ""], correctIndex: null, explanation: "" };
      const subchunks = splitInlineOptions(cur.text);
      if (subchunks.length > 1) {
        cur.text = "";
        subchunks.forEach((subchunk) => processChunk(subchunk));
      }
      return;
    }

    if (!cur) return;

    if (ansMatch) {
      const idx = letterToIndex(ansMatch[1]);
      if (idx != null) {
        cur.correctIndex = idx;
      }
      return;
    }

    if (numAnsMatch) {
      const idx = letterToIndex(numAnsMatch[1]);
      if (idx != null) {
        cur.correctIndex = idx;
      }
      return;
    }

    if (!cur.correctIndex && ANSWER_ONLY_RE.test(chunk) && cur.options.some((o) => o && o.trim())) {
      const idx = letterToIndex(chunk.trim());
      if (idx != null) {
        cur.correctIndex = idx;
        return;
      }
    }

    if (!cur.correctIndex && ANSWER_NUMERIC_ONLY_RE.test(chunk) && cur.options.some((o) => o && o.trim())) {
      const idx = letterToIndex(chunk.trim());
      if (idx != null) {
        cur.correctIndex = idx;
        return;
      }
    }

    if (expMatch) {
      cur.explanation = expMatch[1];
      return;
    }

    if (optMatch) {
      const idx = letterToIndex(optMatch[1]);
      if (idx != null) {
        const content = optMatch[2].trim();
        if (content) {
          cur.options[idx] = cur.options[idx] ? `${cur.options[idx]} ${content}` : content;
        }
      }
      return;
    }

    // Continuation of previous content
    if (cur.explanation) {
      cur.explanation += " " + chunk;
    } else if (cur.options.some((o) => o && o.trim())) {
      for (let k = cur.options.length - 1; k >= 0; k--) {
        if (cur.options[k] && cur.options[k].trim()) {
          cur.options[k] += " " + chunk;
          break;
        }
      }
    } else {
      cur.text += (cur.text ? " " : "") + chunk;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const chunks = splitInlineOptions(line);
    for (const chunk of chunks) {
      processChunk(chunk);
    }
  }
  push();

  return questions;
}
