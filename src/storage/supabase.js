import { supabase } from "../supabase.js";

function handleError(error) {
  if (error) throw error;
}

// Convert camelCase to snake_case (handles acronyms properly)
function toSnakeCase(obj) {
  const converted = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key
      .replace(/([a-z])([A-Z])/g, '$1_$2')           // lowercase to uppercase
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')    // sequence of capitals
      .toLowerCase();
    converted[snakeKey] = value;
  }
  return converted;
}

// Convert snake_case to camelCase
function toCamelCase(obj) {
  if (!obj) return obj;
  const converted = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
    converted[camelKey] = value;
  }
  return converted;
}

export const supabaseStorage = {
  async getProfile(userId) {
    const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).single();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getProfileByEmail(email) {
    const normalizedEmail = email.trim().toLowerCase();
    const { data, error } = await supabase.from("profiles").select("*").eq("email", normalizedEmail).single();
    if (error && error.code !== "PGRST116") handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async saveProfile(userId, profile) {
    const dbPayload = toSnakeCase({ id: userId, ...profile });
    const { data, error } = await supabase
      .from("profiles")
      .upsert(dbPayload, { onConflict: "id" })
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getAttempts(userId) {
    const { data, error } = await supabase
      .from("attempts")
      .select("*")
      .eq("user_id", userId)
      .order("date", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addAttempt(userId, attempt) {
    const dbPayload = toSnakeCase({ user_id: userId, ...attempt });
    const { data, error } = await supabase
      .from("attempts")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async getPapers(userId) {
    const { data, error } = await supabase
      .from("papers")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addPaper(userId, paper) {
    const dbPayload = toSnakeCase({ user_id: userId, ...paper });
    const { data, error } = await supabase
      .from("papers")
      .insert([dbPayload])
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async deletePaper(userId, paperId) {
    const { error } = await supabase
      .from("papers")
      .delete()
      .eq("id", paperId)
      .eq("user_id", userId);
    handleError(error);
  },

  async resetUser(userId) {
    const profileReset = toSnakeCase({
      streak: 0,
      totalPoints: 0,
      lastQuizDate: "",
    });

    const results = await Promise.all([
      supabase.from("attempts").delete().eq("user_id", userId),
      supabase.from("papers").delete().eq("user_id", userId),
      supabase.from("profiles").update(profileReset).eq("id", userId),
    ]);

    results.forEach((result) => handleError(result.error));
  },

  async ensureSeed() {
    // no-op — Supabase tables are managed via migrations.
  },

  async getQuestions() {
    const { data, error } = await supabase.from("questions").select("*");
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async addQuestions(questions) {
    const dbPayload = questions.map(toSnakeCase);
    const { data, error } = await supabase
      .from("questions")
      .upsert(dbPayload, { onConflict: "id" })
      .select();
    handleError(error);
    return data ? data.map(toCamelCase) : [];
  },

  async updateQuestion(id, updates) {
    const dbPayload = toSnakeCase(updates);
    const { data, error } = await supabase
      .from("questions")
      .update(dbPayload)
      .eq("id", id)
      .select()
      .single();
    handleError(error);
    return data ? toCamelCase(data) : null;
  },

  async deleteQuestion(id) {
    const { error } = await supabase.from("questions").delete().eq("id", id);
    handleError(error);
  },
};
