// Supabase storage adapter — STUB. Implement when you're ready to wire up Supabase.
// Suggested tables:
//   profiles(id text primary key, name, role, target_exam, streak, last_quiz_date,
//            total_points, badges jsonb, rank int, is_onboarded bool)
//   attempts(id text primary key, user_id text, quiz_id text, title, subject, exam_type,
//            score int, total_questions int, time_spent int, date timestamptz,
//            answers jsonb, weak_topics text[])
//   papers(id text primary key, user_id text, title, exam_type, subject, topic,
//          difficulty, questions jsonb, created_at timestamptz)
//
// To enable:
//   1. npm i @supabase/supabase-js   (inside server/)
//   2. Set STORAGE=supabase, SUPABASE_URL, SUPABASE_ANON_KEY in server/.env
//   3. Fill in the methods below using `supabase.from(...)` calls.

export const supabaseStorage = {
  async getProfile(_userId) {
    throw new Error("Supabase adapter not implemented yet. Set STORAGE=json in server/.env for now.");
  },
  async saveProfile() { throw new Error("not implemented"); },
  async getAttempts() { throw new Error("not implemented"); },
  async addAttempt() { throw new Error("not implemented"); },
  async getPapers() { throw new Error("not implemented"); },
  async addPaper() { throw new Error("not implemented"); },
  async deletePaper() { throw new Error("not implemented"); },
  async resetUser() { throw new Error("not implemented"); },
  async ensureSeed() { /* no-op — Supabase tables are managed via migrations */ },
  async getQuestions() { throw new Error("not implemented"); },
  async addQuestions() { throw new Error("not implemented"); },
  async updateQuestion() { throw new Error("not implemented"); },
  async deleteQuestion() { throw new Error("not implemented"); },
};
