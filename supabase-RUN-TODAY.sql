-- Run this ONCE in the Supabase dashboard → SQL Editor → New query → Run.
-- It adds the columns the app now uses. Safe to run multiple times
-- (IF NOT EXISTS guards). Without these columns the server silently drops
-- subtopic + multi-class data, so the Paper Generator's subtopic dropdown
-- stays empty.

-- Finer classification under a topic (e.g. "Biot-Savart Law").
ALTER TABLE questions ADD COLUMN IF NOT EXISTS subtopic text;

-- Every class a question belongs to (multi-class). The single `class_level`
-- column is kept for backward compatibility.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS class_levels text[];

-- Optional: quick lookups when filtering the bank by subtopic.
CREATE INDEX IF NOT EXISTS idx_questions_subtopic ON questions (subtopic);
