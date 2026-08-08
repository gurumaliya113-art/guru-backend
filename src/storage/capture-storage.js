// Storage helper for "captured paper" images — i.e. snapshots a teacher
// takes of handwritten/printed questions and uploads as a paper.
//
// Two backends:
//   - "supabase": uploads each image to a PUBLIC Storage bucket
//                 (default name: "paper-captures") and returns the public
//                 URL so the <img> tag in PaperView can render it directly.
//   - "local":    saves to backend/data/captures/<paperId>/<n>.<ext> and
//                 returns a /api/captures/<paperId>/<n>.<ext> URL the
//                 backend serves back via a static route.
//
// The bucket MUST be created manually in Supabase Dashboard → Storage
// (public read). The error message below tells the operator exactly what
// to do if it's missing.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { supabase } from "../supabase.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOCAL_DIR = path.resolve(__dirname, "..", "..", "data", "captures");
const BUCKET = process.env.SUPABASE_CAPTURES_BUCKET || "paper-captures";

function ensureLocalDir(paperId) {
  const dir = path.join(LOCAL_DIR, paperId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extFromMime(mime) {
  if (!mime) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Persist a single image and return a URL that can be used in an <img src>.
 * @param {object} args
 * @param {string} args.paperId  used as the folder name so a paper's images stay grouped
 * @param {number} args.index    zero-based index of this image within the paper
 * @param {Buffer} args.buffer
 * @param {string} args.mimetype
 * @returns {Promise<string>}    public-accessible URL
 */
export async function saveCaptureImage({ paperId, index, buffer, mimetype }) {
  const useSupabase = process.env.STORAGE === "supabase";
  const ext = extFromMime(mimetype);
  const key = `${paperId}/${index}.${ext}`;

  if (useSupabase) {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(key, buffer, {
        contentType: mimetype || "image/jpeg",
        upsert: true,
      });
    if (error) {
      if (/bucket.*not.*found/i.test(error.message)) {
        throw new Error(
          `Supabase Storage bucket "${BUCKET}" not found. Create it in ` +
          `Supabase Dashboard → Storage → New bucket → name "${BUCKET}", ` +
          `Public bucket = ON.`
        );
      }
      throw error;
    }
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
    return data.publicUrl;
  }

  // Local fallback (dev only).
  const dir = ensureLocalDir(paperId);
  const file = path.join(dir, `${index}.${ext}`);
  fs.writeFileSync(file, buffer);
  // The /api/captures/* static route (registered in index.js) serves this.
  return `/api/captures/${paperId}/${index}.${ext}`;
}

export const CAPTURES_LOCAL_DIR = LOCAL_DIR;
