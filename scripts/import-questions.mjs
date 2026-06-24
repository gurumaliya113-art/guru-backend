// =============================================================
//  Import hand-authored question JSON files into the DB.
//  Reads every *.json file in scripts/data/ and inserts via the
//  app's storage layer (supabase or json, same as the server).
//
//  Each JSON file shape:
//   {
//     "classLevel": "1", "subject": "Mathematics",
//     "questions": [
//       { "text": "...", "type": "mcq|fill|truefalse",
//         "options": [".."], "correctIndex": 0, "explanation": "..",
//         "topic": "Addition", "difficulty": "Easy" }
//     ]
//   }
//
//  Usage (from backend/):  node scripts/import-questions.mjs
//                          node scripts/import-questions.mjs --dry
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

const DRY = process.argv.includes("--dry");
const storage =
  process.env.STORAGE === "supabase" && supabase ? supabaseStorage : jsonStorage;
console.log(`[import] storage = ${process.env.STORAGE === "supabase" && supabase ? "supabase" : "json"}${DRY ? " (DRY RUN)" : ""}`);

const DATA_DIR = path.join(__dirname, "data");
const IMPORTED_FILE = path.join(__dirname, ".imported.json");
const newId = () => "q_" + crypto.randomBytes(5).toString("hex");

function loadImported() {
  try { return new Set(JSON.parse(fs.readFileSync(IMPORTED_FILE, "utf-8"))); }
  catch { return new Set(); }
}
function saveImported(set) {
  fs.writeFileSync(IMPORTED_FILE, JSON.stringify([...set], null, 2));
}

const TYPE_MAP = {
  mcq: "MCQ",
  fill: "Fill-in-the-Blank",
  truefalse: "True-False",
  "true-false": "True-False",
  assertion: "Assertion-Reason",
  "assertion-reason": "Assertion-Reason",
  short: "Short Answer",
  "short answer": "Short Answer",
  long: "Long Answer",
  "long answer": "Long Answer",
  match: "Match the Following",
  "match the following": "Match the Following",
  case: "Case-Based",
  numerical: "Numerical",
};
// Types that don't need 4 MCQ options (answer lives in `explanation`).
const OPEN_TYPES = new Set(["Short Answer", "Long Answer", "Match the Following", "Assertion-Reason"]);

function normalize(q, classLevel, subject) {
  const type = String(q.type || "mcq").toLowerCase().trim();
  const typeLabel = TYPE_MAP[type] || "MCQ";
  let options = Array.isArray(q.options) ? q.options.map((o) => String(o ?? "").trim()) : [];
  if (typeLabel === "True-False" && options.length === 0) options = ["True", "False"];
  // MCQ-style types are padded to 4; open-ended types keep what's given.
  if (!OPEN_TYPES.has(typeLabel)) {
    options = options.slice(0, 4);
    while (options.length < 4 && options.length > 0) options.push("");
  }
  let ci = Number.isInteger(q.correctIndex) ? q.correctIndex : 0;
  if (ci < 0 || ci >= options.length) ci = 0;
  return {
    id: q.id || newId(),
    subject,
    topic: String(q.topic || "").trim(),
    text: String(q.text || "").trim(),
    options,
    correctIndex: ci,
    explanation: String(q.explanation || q.answer || "").trim(),
    difficulty: ["Easy", "Moderate", "Hard"].includes(q.difficulty) ? q.difficulty : "Easy",
    type: typeLabel,
    examType: Array.isArray(q.examType) && q.examType.length ? q.examType : ["BOARD"],
    classLevel: String(classLevel),
    board: "CBSE",
    isNCERT: true,
    source: "curated",
    createdAt: new Date().toISOString(),
  };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`[import] no data dir: ${DATA_DIR}. Create scripts/data/*.json first.`);
    process.exit(1);
  }
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) { console.log("[import] no .json files found in scripts/data/"); process.exit(0); }

  const imported = loadImported();
  let grand = 0, inserted = 0;
  for (const file of files) {
    if (imported.has(file)) { console.log(`= skip (already imported): ${file}`); continue; }
    const full = path.join(DATA_DIR, file);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(full, "utf-8")); }
    catch (e) { console.warn(`[import] skip ${file}: bad JSON (${e.message})`); continue; }

    const classLevel = doc.classLevel || "1";
    const subject = doc.subject || "General Knowledge";
    const list = Array.isArray(doc.questions) ? doc.questions : [];
    const rows = list.map((q) => normalize(q, classLevel, subject)).filter((q) => q.text && (q.options.some((o) => o) || OPEN_TYPES.has(q.type)));
    grand += rows.length;
    console.log(`> ${file}: Class ${classLevel} · ${subject} · ${rows.length} questions`);

    if (rows.length && !DRY) {
      try {
        const added = await storage.addQuestions(rows);
        inserted += Array.isArray(added) ? added.length : rows.length;
        imported.add(file);
        saveImported(imported);
      } catch (e) {
        console.warn(`  insert failed: ${(e?.message || e).toString().slice(0, 140)}`);
      }
    }
  }
  console.log(`\n[import] files=${files.length} generated=${grand} inserted=${inserted}${DRY ? " (dry)" : ""}`);
  process.exit(0);
}

main().catch((e) => { console.error("[import] fatal:", e); process.exit(1); });
