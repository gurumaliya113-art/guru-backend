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

const QUESTION_START_RE = /^\s*(?:Q\.?\s*)?(\d{1,3})[\.\)]\s+(.+)$/i;
const OPTION_RE = /^\s*(?:\(?([A-Da-d1-4])\)?[\.\)]?)\s+(.+)$/;
const ANSWER_RE = /^\s*(?:Answer|Ans|Correct\s*(?:answer|option))\s*[:\-]?\s*\(?([A-Da-d1-4])\)?/i;
const EXPLANATION_RE = /^\s*(?:Explanation|Solution|Sol|Reason)\s*[:\-]\s*(.+)$/i;

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
  const text = (rawText || "").replace(/\r\n/g, "\n").replace(/\t/g, " ");
  const lines = text.split("\n").map((l) => l.trim());

  const questions = [];
  let cur = null;
  let pendingExplanation = "";

  const push = () => {
    if (!cur) return;
    const opts = cur.options.filter((o) => o && o.trim());
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const qMatch = line.match(QUESTION_START_RE);
    const optMatch = line.match(OPTION_RE);
    const ansMatch = line.match(ANSWER_RE);
    const expMatch = line.match(EXPLANATION_RE);

    if (qMatch) {
      push();
      cur = { text: qMatch[2], options: [], correctIndex: null, explanation: "" };
      continue;
    }

    if (!cur) continue;

    if (ansMatch) {
      cur.correctIndex = letterToIndex(ansMatch[1]);
      continue;
    }

    if (expMatch) {
      cur.explanation = expMatch[1];
      continue;
    }

    if (optMatch && cur.options.length < 4) {
      const idx = letterToIndex(optMatch[1]);
      if (idx != null) {
        cur.options[idx] = optMatch[2];
        continue;
      }
    }

    // Continuation of previous content
    if (cur.explanation) {
      cur.explanation += " " + line;
    } else if (cur.options.length > 0) {
      // append to last filled option
      for (let k = cur.options.length - 1; k >= 0; k--) {
        if (cur.options[k]) { cur.options[k] += " " + line; break; }
      }
    } else {
      cur.text += " " + line;
    }
  }
  push();

  return questions;
}
