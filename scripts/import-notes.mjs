// =============================================================
//  Import hand-authored NOTES JSON files into the DB.
//  Reads every *.json file in scripts/notes-data/ and inserts via
//  the app's storage layer (supabase or json, same as the server).
//
//  Each JSON file shape:
//   {
//     "examType": "NEET",        // NEET | JEE | BOARD
//     "classLevel": "11",        // 11 | 12 | ...
//     "board": "CBSE",
//     "subject": "Physics",      // Physics | Chemistry | Biology | Mathematics
//     "notes": [
//       {
//         "chapter": "Units and Measurements",
//         "title": "Units and Measurements — Key Concepts",
//         "description": "markdown body with the important concepts..."
//       }
//     ]
//   }
//
//  Usage (from backend/):  node scripts/import-notes.mjs
//                          node scripts/import-notes.mjs --dry
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
const useSupabase = process.env.STORAGE === "supabase" && supabase;
const storage = useSupabase ? supabaseStorage : jsonStorage;
console.log(`[notes] storage = ${useSupabase ? "supabase" : "json"}${DRY ? " (DRY RUN)" : ""}`);

const DATA_DIR = path.join(__dirname, "notes-data");
const newId = () => "note_" + crypto.randomBytes(6).toString("hex");

function normalize(n, meta) {
  const now = new Date().toISOString();
  return {
    id: n.id || newId(),
    title: String(n.title || n.chapter || "").trim(),
    subject: String(meta.subject || "").trim(),
    chapter: n.chapter ? String(n.chapter).trim() : null,
    examType: meta.examType ? String(meta.examType).trim() : null,
    classLevel: meta.classLevel ? String(meta.classLevel).trim() : null,
    board: meta.board ? String(meta.board).trim() : "CBSE",
    description: String(n.description || "").trim(),
    fileUrl: n.fileUrl ? String(n.fileUrl).trim() : null,
    uploadedBy: "curated",
    createdAt: now,
  };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`[notes] no data dir: ${DATA_DIR}. Create scripts/notes-data/*.json first.`);
    process.exit(1);
  }
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) { console.log("[notes] no .json files found in scripts/notes-data/"); process.exit(0); }

  let grand = 0, inserted = 0, removed = 0;

  for (const file of files) {
    const full = path.join(DATA_DIR, file);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(full, "utf-8")); }
    catch (e) { console.warn(`[notes] skip ${file}: bad JSON (${e.message})`); continue; }

    const meta = {
      examType: doc.examType || null,
      classLevel: doc.classLevel || null,
      board: doc.board || "CBSE",
      subject: doc.subject || "General",
    };
    const list = Array.isArray(doc.notes) ? doc.notes : [];
    const rows = list.map((n) => normalize(n, meta)).filter((n) => n.title && n.description);
    grand += rows.length;
    console.log(`> ${file}: ${meta.examType} · Class ${meta.classLevel} · ${meta.subject} · ${rows.length} notes`);

    if (!rows.length || DRY) continue;

    // Replace semantics: remove existing curated notes for this exam/class/subject
    // so re-running the importer syncs the DB to the JSON (no duplicates).
    try {
      const existing = await storage.getNotes({ examType: meta.examType, classLevel: meta.classLevel });
      const stale = (existing || []).filter(
        (e) => e.subject === meta.subject && (e.uploadedBy === "curated")
      );
      for (const s of stale) {
        try { await storage.deleteNote?.(s.id); removed += 1; } catch { /* ignore */ }
      }
    } catch (e) {
      console.warn(`  could not clear existing notes: ${(e?.message || e).toString().slice(0, 120)}`);
    }

    let ok = 0;
    for (const row of rows) {
      try { await storage.addNote(row); ok += 1; }
      catch (e) { console.warn(`  insert failed (${row.chapter}): ${(e?.message || e).toString().slice(0, 140)}`); }
    }
    inserted += ok;
  }

  console.log(`\n[notes] files=${files.length} generated=${grand} removed=${removed} inserted=${inserted}${DRY ? " (dry)" : ""}`);
  process.exit(0);
}

main().catch((e) => { console.error("[notes] fatal:", e); process.exit(1); });
