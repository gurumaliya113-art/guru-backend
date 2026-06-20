// Import full mock/previous-year papers into the `pyps` catalogue.
// Reads every *.json file in scripts/pyp/ and inserts via storage.addPyp.
//
// File shape:
//  { "title","examType","year","subject"?,"durationMinutes"?,
//    "questions":[ { "subject","topic","text","options":[..],"correctIndex",
//                    "explanation","type"("MCQ"|"Numerical"),"difficulty" } ] }
//
// For Numerical questions put the answer as options[0] (correctIndex 0).
//
// Usage (from backend/):  node scripts/import-pyp.mjs
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

const storage = process.env.STORAGE === "supabase" && supabase ? supabaseStorage : jsonStorage;
console.log(`[pyp] storage = ${process.env.STORAGE === "supabase" && supabase ? "supabase" : "json"}`);

const DIR = path.join(__dirname, "pyp");
const IMPORTED = path.join(__dirname, ".pyp-imported.json");
const newId = (p) => p + "_" + crypto.randomBytes(5).toString("hex");

function loadImported() { try { return new Set(JSON.parse(fs.readFileSync(IMPORTED, "utf-8"))); } catch { return new Set(); } }
function saveImported(s) { fs.writeFileSync(IMPORTED, JSON.stringify([...s], null, 2)); }

function normQ(q) {
  const type = /numer/i.test(q.type || "") ? "Numerical" : "MCQ";
  let options = Array.isArray(q.options) ? q.options.map((o) => String(o ?? "")) : [];
  if (type === "MCQ") { options = options.slice(0, 4); while (options.length < 4) options.push(""); }
  return {
    id: newId("q"),
    subject: q.subject || "Physics",
    topic: q.topic || "",
    text: String(q.text || "").trim(),
    options,
    correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
    explanation: String(q.explanation || "").trim(),
    difficulty: ["Easy", "Moderate", "Hard"].includes(q.difficulty) ? q.difficulty : "Moderate",
    type,
    examType: Array.isArray(q.examType) && q.examType.length ? q.examType : ["JEE"],
    createdAt: new Date().toISOString(),
  };
}

async function main() {
  if (!fs.existsSync(DIR)) { console.error(`[pyp] no dir ${DIR}`); process.exit(1); }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
  const imported = loadImported();
  for (const file of files) {
    if (imported.has(file)) { console.log(`= skip (done): ${file}`); continue; }
    const doc = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf-8"));
    const questions = (doc.questions || []).map(normQ).filter((q) => q.text);
    const pyp = {
      id: newId("pyp"),
      title: doc.title || "Mock Test",
      examType: doc.examType || "JEE",
      year: Number(doc.year) || new Date().getFullYear(),
      subject: doc.subject || null,
      durationMinutes: Number(doc.durationMinutes) || 180,
      questions,
      createdAt: new Date().toISOString(),
    };
    try {
      await storage.addPyp(pyp);
      imported.add(file); saveImported(imported);
      console.log(`> ${file}: "${pyp.title}" — ${questions.length} questions inserted`);
    } catch (e) {
      console.warn(`  insert failed for ${file}: ${(e?.message || e).toString().slice(0, 160)}`);
    }
  }
  console.log("[pyp] done.");
  process.exit(0);
}
main().catch((e) => { console.error("[pyp] fatal:", e); process.exit(1); });
