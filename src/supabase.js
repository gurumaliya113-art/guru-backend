import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let _supabase = null;
if (url && key) {
  try {
    _supabase = createClient(url, key, {
      auth: { persistSession: false },
    });
  } catch (e) {
    console.warn("[supabase] client init failed, continuing without supabase:", e && e.message ? e.message : e);
    _supabase = null;
  }
}

export const supabase = _supabase;
