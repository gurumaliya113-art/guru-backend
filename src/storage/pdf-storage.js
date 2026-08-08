// PDF byte storage. Two backends:
//   - "supabase": uploads bytes to a private Storage bucket "papers"
//   - "local":    saves to backend/data/pdfs/<id>.pdf
//
// Returns a `storagePath` you can persist in the documents row.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { supabase } from "../supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_DIR = path.resolve(__dirname, "..", "..", "data", "pdfs");
const LOCAL_PAGES_DIR = path.resolve(__dirname, "..", "..", "data", "pages");
const BUCKET = process.env.SUPABASE_PDF_BUCKET || "papers";

function ensureLocalDir() {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
}
function ensureLocalPagesDir(docId) {
  const dir = path.join(LOCAL_PAGES_DIR, docId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newDocumentId() {
  return "doc_" + crypto.randomBytes(6).toString("hex");
}

export async function saveDocumentBytes({ id, filename, buffer }) {
  const useSupabase = process.env.STORAGE === "supabase";
  const safeName = (filename || "file.pdf").replace(/[^\w.\-]+/g, "_");
  const objectKey = `${id}/${safeName}`;
  const ext = path.extname(safeName).toLowerCase() || ".pdf";
  const contentType =
    ext === ".docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : ext === ".doc"
      ? "application/msword"
      : ext === ".pdf"
      ? "application/pdf"
      : "application/octet-stream";

  if (useSupabase) {
    if (!supabase) {
      throw new Error("Supabase storage is configured (STORAGE=supabase) but SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/ANON_KEY are not set.");
    }
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(objectKey, buffer, {
        contentType,
        upsert: false,
      });
    if (error) {
      // If the bucket doesn't exist yet, give a helpful error
      if (/bucket.*not.*found/i.test(error.message)) {
        throw new Error(
          `Supabase Storage bucket "${BUCKET}" not found. Create it (private) in Supabase Dashboard → Storage.`
        );
      }
      throw error;
    }
    return { backend: "supabase", path: `${BUCKET}/${objectKey}`, sizeBytes: buffer.length };
  }

  ensureLocalDir();
  const localPath = path.join(LOCAL_DIR, `${id}${ext}`);
  fs.writeFileSync(localPath, buffer);
  return { backend: "local", path: localPath, sizeBytes: buffer.length };
}

export async function getPdfBytes(storagePath, backend) {
  if (backend === "supabase") {
    const [bucket, ...rest] = storagePath.split("/");
    const key = rest.join("/");
    const { data, error } = await supabase.storage.from(bucket).download(key);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }
  return fs.readFileSync(storagePath);
}

// ---- Page-image storage (PNG snapshots of PDF pages with diagrams) ----

/**
 * Save a rendered PDF page as PNG. Stored under:
 *   supabase: papers/<docId>/pages/page-<n>.png
 *   local:    backend/data/pages/<docId>/page-<n>.png
 * Returns { backend, path, sizeBytes }.
 */
export async function savePageImage({ docId, pageNumber, buffer }) {
  const useSupabase = process.env.STORAGE === "supabase";
  const filename = `page-${pageNumber}.png`;
  if (useSupabase) {
    if (!supabase) {
      throw new Error("Supabase storage is configured (STORAGE=supabase) but SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/ANON_KEY are not set.");
    }
    const objectKey = `${docId}/pages/${filename}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(objectKey, buffer, { contentType: "image/png", upsert: true });
    if (error) {
      if (/bucket.*not.*found/i.test(error.message)) {
        throw new Error(`Supabase Storage bucket "${BUCKET}" not found.`);
      }
      throw error;
    }
    return { backend: "supabase", path: `${BUCKET}/${objectKey}`, sizeBytes: buffer.length };
  }
  const dir = ensureLocalPagesDir(docId);
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);
  return { backend: "local", path: fullPath, sizeBytes: buffer.length };
}

// ---- Per-question figure crops (a diagram cropped out of a page) ----
// Stored under <docId>/figures/<name>.png so a page can hold many crops.

function sanitizeName(name) {
  return String(name || "fig").replace(/[^\w.\-]+/g, "_");
}

export async function saveFigureImage({ docId, name, buffer }) {
  const useSupabase = process.env.STORAGE === "supabase";
  const filename = `${sanitizeName(name)}.png`;
  if (useSupabase) {
    if (!supabase) {
      throw new Error("Supabase storage is configured (STORAGE=supabase) but keys are not set.");
    }
    const objectKey = `${docId}/figures/${filename}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(objectKey, buffer, { contentType: "image/png", upsert: true });
    if (error) throw error;
    return { backend: "supabase", path: `${BUCKET}/${objectKey}`, sizeBytes: buffer.length };
  }
  const dir = path.join(LOCAL_PAGES_DIR, docId, "figures");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);
  return { backend: "local", path: fullPath, sizeBytes: buffer.length };
}

export async function getFigureImageBytes({ docId, name, backend }) {
  const filename = `${sanitizeName(name)}.png`;
  if (backend === "supabase") {
    if (!supabase) throw new Error("Supabase storage configured but keys are not set.");
    const key = `${docId}/figures/${filename}`;
    const { data, error } = await supabase.storage.from(BUCKET).download(key);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }
  const fullPath = path.join(LOCAL_PAGES_DIR, docId, "figures", filename);
  if (!fs.existsSync(fullPath)) throw new Error("Figure image not found");
  return fs.readFileSync(fullPath);
}

/** Fetch a stored page image. Mirrors getPdfBytes. */
export async function getPageImageBytes({ docId, pageNumber, backend }) {
  if (backend === "supabase") {
    if (!supabase) {
      throw new Error("Supabase storage is configured (STORAGE=supabase) but SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/ANON_KEY are not set.");
    }
    const key = `${docId}/pages/page-${pageNumber}.png`;
    const { data, error } = await supabase.storage.from(BUCKET).download(key);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
  }
  const fullPath = path.join(LOCAL_PAGES_DIR, docId, `page-${pageNumber}.png`);
  if (!fs.existsSync(fullPath)) throw new Error("Page image not found");
  return fs.readFileSync(fullPath);
}
